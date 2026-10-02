#!/bin/bash
# Setup for aniplay on a Raspberry Pi / any Debian-like box in your home network.
#
# What it does
#   - Node 22.13+ (installs Node 24 from NodeSource if missing)
#   - clones or pulls the app into an app folder
#   - env file in /etc/<service>.env, sqlite data in /var/lib/<service>
#   - systemd service on the chosen port, starts on boot
#   No domain, no HTTPS, nothing opened to the internet: aniplay runs in your WLAN.
#   Every TV that opens /watcher gets its own code; phones pair with exactly that TV.
#
# Interactive: the script asks for every setting and proposes a default. Press Enter to accept.
# Non-interactive: pass values as env vars and/or `--yes` to take all defaults, e.g.
#   PORT=3000 bash setup-pi.sh --yes
#   curl -fsSL https://raw.githubusercontent.com/vxnsin/aniplay/main/scripts/setup-pi.sh | bash
# Re-running is safe: it pulls, installs and restarts instead of reinstalling.
#
# Settings (env var → question → default):
#   REPO            github repo to clone                     vxnsin/aniplay
#   APP_DIR         app folder                               $HOME/aniplay
#   PORT            port                                     3000
#   SERVICE         systemd service / file names             aniplay
#   DATA_DIR        sqlite folder                            /var/lib/<service>
#   PUBLIC_URL      address in the qr codes                  (empty = the pi's LAN ip, found automatically)
set -euo pipefail

YES=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) YES=1 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
  esac
done
[ -t 0 ] || [ -r /dev/tty ] || YES=1 # no terminal at all: take defaults

if [ "$EUID" -eq 0 ]; then
  echo "Bitte als normaler Benutzer ausfuehren, nicht als root (das Script nutzt sudo)."; exit 1
fi

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
# ask VAR "Frage" "default"  – keeps a value that came in as env var, otherwise asks (or takes the default with --yes)
ask() {
  local var="$1" prompt="$2" def="$3" ans=""
  if [ -n "${!var:-}" ]; then return; fi
  if [ "$YES" -eq 1 ]; then printf -v "$var" '%s' "$def"; return; fi
  read -r -p "$prompt [${def:-leer}]: " ans < /dev/tty || ans=""
  printf -v "$var" '%s' "${ans:-$def}"
}

# ---------------------------------------------------------------- settings
say "Einstellungen (Enter = Vorschlag uebernehmen)"
ask REPO     "GitHub-Repo (owner/name)" "vxnsin/aniplay"
ask APP_DIR  "App-Ordner" "$HOME/aniplay"
ask PORT     "Port" "3000"
ask SERVICE  "Dienstname (systemd, Dateinamen)" "aniplay"
ask DATA_DIR "Datenordner (sqlite)" "/var/lib/$SERVICE"
ask PUBLIC_URL "Adresse fuer die QR-Codes, z. B. http://$(hostname).local:$PORT (leer = IP automatisch)" ""
ENV_FILE="/etc/$SERVICE.env"
USER_NAME="$(id -un)"

cat <<SUMMARY

  Repo:        $REPO
  App-Ordner:  $APP_DIR
  Port:        $PORT
  Dienst:      $SERVICE   (Env: $ENV_FILE, Daten: $DATA_DIR)
  QR-Adresse:  ${PUBLIC_URL:-automatisch (LAN-IP)}
SUMMARY
if [ "$YES" -eq 0 ]; then
  read -r -p "So einrichten? (J/n): " ok < /dev/tty || ok="j"
  case "${ok,,}" in n|no|nein) echo "Abgebrochen."; exit 1 ;; esac
fi

# ---------------------------------------------------------------- packages
say "System-Pakete"
sudo apt-get update -qq
sudo apt-get install -y -qq git curl ca-certificates gnupg

# ---------------------------------------------------------------- node
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  MINOR="$(node -p 'process.versions.node.split(".")[1]')"
  if [ "$MAJOR" -gt 22 ] || { [ "$MAJOR" -eq 22 ] && [ "$MINOR" -ge 13 ]; }; then NEED_NODE=0; fi # node:sqlite needs 22.13+
fi
if [ "$NEED_NODE" -eq 1 ]; then
  say "Node 24 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
say "Node $(node -v), npm $(npm -v)"

# ---------------------------------------------------------------- data dir
say "Datenverzeichnis $DATA_DIR"
sudo mkdir -p "$DATA_DIR"
sudo chown -R "$USER_NAME:$USER_NAME" "$DATA_DIR"

# ---------------------------------------------------------------- app
if [ -d "$APP_DIR/.git" ]; then
  say "Repo aktualisieren ($APP_DIR)"
  git -C "$APP_DIR" pull --ff-only
else
  say "Repo klonen nach $APP_DIR"
  git clone "https://github.com/${REPO}.git" "$APP_DIR"
fi

# a data folder from running it by hand before: move it over once
if [ -d "$APP_DIR/data" ] && [ ! -L "$APP_DIR/data" ] && [ -z "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
  say "Vorhandene Daten aus $APP_DIR/data uebernehmen"
  cp -a "$APP_DIR/data/." "$DATA_DIR/"
fi

# ---------------------------------------------------------------- env file
if [ ! -f "$ENV_FILE" ]; then
  say "Env-Datei $ENV_FILE anlegen"
  {
    echo "NODE_ENV=production"
    echo "PORT=$PORT"
    echo "DATA_DIR=$DATA_DIR"
    echo "# Adresse in den QR-Codes; leer = LAN-IP automatisch"
    echo "PUBLIC_URL=$PUBLIC_URL"
  } | sudo tee "$ENV_FILE" >/dev/null
  sudo chown "$USER_NAME:$USER_NAME" "$ENV_FILE"
  sudo chmod 600 "$ENV_FILE"
else
  # keep the env file in sync with what was answered this time
  for kv in "PORT=$PORT" "DATA_DIR=$DATA_DIR" "PUBLIC_URL=$PUBLIC_URL"; do
    k="${kv%%=*}"
    if grep -q "^$k=" "$ENV_FILE"; then sudo sed -i "s#^$k=.*#$kv#" "$ENV_FILE"; else echo "$kv" | sudo tee -a "$ENV_FILE" >/dev/null; fi
  done
fi

# ---------------------------------------------------------------- install
say "npm ci"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------- systemd
say "systemd-Dienst $SERVICE"
sudo tee "/etc/systemd/system/$SERVICE.service" >/dev/null <<UNIT
[Unit]
Description=aniplay (port $PORT)
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE" >/dev/null
sudo systemctl restart "$SERVICE"

# ---------------------------------------------------------------- summary
LAN_IP="$(hostname -I | awk '{print $1}')"
BASE="${PUBLIC_URL:-http://$LAN_IP:$PORT}"
sleep 2
if curl -fs "http://localhost:$PORT/api/info" >/dev/null; then STATUS="laeuft"; else STATUS="startet noch – Logs pruefen"; fi
say "Fertig ($STATUS)"
cat <<SUMMARY

  TV:            $BASE/watcher        (jeder Fernseher bekommt einen eigenen Code)
  Fernbedienung: QR-Code auf dem TV scannen, oder $BASE/controller und den Code eingeben
  Dienst:        sudo systemctl status $SERVICE     Logs: journalctl -u $SERVICE -f
  Env:           $ENV_FILE  (danach: sudo systemctl restart $SERVICE)
  Daten:         $DATA_DIR/aniplay.sqlite

Tipps:
  - Gib dem Pi im Router eine feste IP, dann bleiben die QR-Codes gueltig.
  - Auf dem TV einfach $BASE/watcher als Lesezeichen oder Startseite speichern.
  - Update: dieses Script nochmal starten, es zieht die neue Version und startet neu.
SUMMARY
