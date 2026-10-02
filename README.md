# aniplay

<!-- cozy:cards -->
<!-- /cozy:cards -->

Anime im Wohnzimmer: Der Fernseher oder PC ist der Player, das Handy die Fernbedienung. Suchen, Folge antippen, auf dem großen Bildschirm schauen und vom Sofa aus pausieren, spulen und weiterschalten. Die Folgen kommen von aniworld.to.

<p align="center"><img src=".github/screenshot.jpg" width="420" alt="aniplay-fernbedienung: anime mit staffeln und episodenliste, gesehene folgen mit haken"></p>

## Was es kann

- **Suche** direkt auf dem Handy, oder einen aniworld-Link einfügen.
- **Staffeln, Filme und Folgen** mit deutschem und englischem Titel und den verfügbaren Sprachen.
- **Sprache und Hoster wechseln**, die Position bleibt erhalten.
- **Weiterschauen:** Jede Folge startet dort, wo du aufgehört hast. Fertig geschaute bekommen einen Haken. Verlauf und Fortschritt liegen in SQLite.
- **AniWorld-Profil**, optional: Namen eintragen, dann zeigt die Fernbedienung zuletzt geschaut, Watchlist und Abos. Gesehene Folgen werden markiert.
- **Autoplay:** Die nächste Folge startet von selbst, auch über Staffelgrenzen. Abschaltbar.
- **Hoster-Fallback:** Spielt eine Quelle auf dem TV nicht, nimmt aniplay automatisch die nächste.
- **QR-Code** auf dem TV zum Verbinden, mehrere Fernbedienungen und mehrere TVs gleichzeitig.
- Die laufende Folge überlebt einen Server-Neustart, der TV spielt einfach weiter.
- Heller und dunkler Modus, folgt dem System.

## Loslegen

Voraussetzung ist Node 22.13 oder neuer.

```bash
git clone https://github.com/vxnsin/aniplay.git
cd aniplay
npm install
npm start
```

Dann im Browser:

| gerät | adresse |
|---|---|
| TV oder PC | `http://<ip-des-rechners>:3000/watcher` |
| Handy | `http://<ip-des-rechners>:3000/controller`, oder den QR-Code auf dem TV scannen |

Beide Geräte müssen im selben WLAN sein. Den Port ändert `PORT=4000 npm start`. Beim Start gibt der Server beide Adressen mit der richtigen IP aus.

## Bedienung

Auf dem Handy: Play/Pause, ±10, 30, 60 und 85 Sekunden, Seek-Leiste, Lautstärke, stumm, Vollbild, vorige und nächste Folge, „von vorne“, TV synchronisieren und Stop.

Tastatur am TV: `Space` Pause, `←` `→` ±10 Sekunden (mit `Shift` ±60), `↑` `↓` Lautstärke, `f` Vollbild, `m` stumm, `i` Info, `Esc` Stop.

## Dauerhaft laufen lassen

Zum Beispiel auf einem Raspberry Pi mit pm2:

```bash
npm i -g pm2
pm2 start server.js --name aniplay
pm2 save
pm2 startup
```

`pm2 startup` gibt einen Befehl aus, den du einmal ausführst, dann startet aniplay beim Booten mit. Die Datenbank liegt in `data/` und lässt sich einfach sichern.

Zum Entwickeln startet `npm run dev` den Server mit nodemon neu, sobald sich Code ändert.

## Hoster

| hoster | modus |
|---|---|
| VOE | HLS, MP4 als Ersatz |
| Vidmoly | HLS |
| Filemoon | HLS, auf manchen Domains nur als Iframe |
| Vidoza, Streamtape | MP4 |
| Doodstream | nur Iframe, dann steuerst du direkt am TV |

Alle Streams laufen über `/api/proxy`, damit Referer und User-Agent der Hoster stimmen.

Einen neuen Hoster einbauen: eine Datei in `lib/loaders/` anlegen, sie wird automatisch geladen.

```js
const name = 'meinhoster';
const aliases = ['meinhoster']; // so wie aniworld den hoster nennt
function matches(url) { return /meinhoster\.com/i.test(url); }
async function resolve(embedUrl, ctx) {
  // seite laden, stream-url herausziehen …
  return { streamType: 'hls', url: 'https://…/master.m3u8', embedUrl, referer: 'https://meinhoster.com/', hosterName: 'MeinHoster' };
}
module.exports = { name, aliases, matches, resolve };
```

`streamType` ist `hls`, `mp4` oder `embed`, letzteres als Iframe-Ersatz.

## Test

```bash
npm test
npm test -- frieren-beyond-journeys-end
```

Der Smoke-Test fragt aniworld.to live ab: Suche, Serie, Staffel, Folge und jeden Hoster einmal.

## Aufbau

```
server.js              Express und WebSocket, API, Stream-Proxy, Zustand
lib/http.js            fetch mit User-Agent und Timeout
lib/aniworld.js        Suche, Serie, Staffel, Folge, Profil
lib/stream-resolve.js  Hoster-Reihenfolge, Weiterleitung zum Loader
lib/store.js           SQLite: Einstellungen, Verlauf, Fortschritt, Session
lib/loaders/           ein Loader pro Hoster
public/                watcher.html (TV), controller.html (Handy), index.html
```

## Hinweise

- Die Inhalte kommen von aniworld.to und den jeweiligen Hostern, aniplay speichert keine Videos. Ob das Ansehen bei dir erlaubt ist, liegt in deiner Verantwortung.
- Zusammen im Discord-Sprachkanal schauen: [aniwatch](https://github.com/vxnsin/aniwatch).

## Lizenz

MIT
