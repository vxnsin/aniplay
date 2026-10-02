/**
 * AniPlay – TV als Player, Handy als Fernbedienung.
 * server.js: Express + WebSocket, stream proxy. Every TV is its own session
 * (lib/session.js); phones pair with one TV through its code / QR code.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');
const WebSocket = require('ws');
const QRCode = require('qrcode');

const aw = require('./lib/aniworld');
const store = require('./lib/store');
const { UA, request } = require('./lib/http');
const { getSession, sessions } = require('./lib/session');
const pkg = require('./package.json');

const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC = path.join(__dirname, 'public');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.disable('x-powered-by');
app.use(express.json());
app.use(express.static(PUBLIC, { extensions: ['html'] }));
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
app.get(['/watcher', '/tv'], (_req, res) => res.sendFile(path.join(PUBLIC, 'watcher.html')));
app.get(['/controller', '/remote'], (_req, res) => res.sendFile(path.join(PUBLIC, 'controller.html')));

// never die on a stray rejection; log it and keep serving the TVs
process.on('unhandledRejection', (e) => console.error('[Unhandled]', e && e.stack ? e.stack : e));
process.on('uncaughtException', (e) => console.error('[Uncaught]', e && e.stack ? e.stack : e));

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────
const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (e) {
    console.error(`[API] ${req.method} ${req.path}:`, e.message);
    res.status(e.status || 500).json({ error: e.message, code: e.code });
  }
};
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

/** the session a request belongs to: header X-TV or ?s= */
function sessionOf(req) {
  const s = getSession(req.get('x-tv') || req.query.s || req.body?.s);
  if (!s) throw fail(404, 'Unbekannter TV – Code auf dem Fernseher prüfen', 'no_tv');
  return s;
}

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name]) {
      if (i.family === 'IPv4' && !i.internal) candidates.push({ name, address: i.address });
    }
  }
  // prefer typical LAN ranges over virtual adapters
  const score = (c) => (/^192\.168\./.test(c.address) ? 3 : /^10\./.test(c.address) ? 2 : /^172\.(1[6-9]|2\d|3[01])\./.test(c.address) ? 1 : 0) - (/vEthernet|WSL|VirtualBox|VMware|Docker|Hyper-V|tailscale|zt/i.test(c.name) ? 5 : 0);
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0]?.address || 'localhost';
}

/** addresses as seen from the LAN; PUBLIC_URL overrides (e.g. http://aniplay.local:3000) */
function urls(code) {
  const base = (process.env.PUBLIC_URL || `http://${getLocalIP()}:${PORT}`).replace(/\/$/, '');
  const q = code ? `?s=${code}` : '';
  return { base, host: base.replace(/^https?:\/\//, ''), watcherUrl: `${base}/watcher`, controllerUrl: `${base}/controller${q}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// TVs and pairing
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/info', (req, res) => {
  const code = store.isCode(String(req.query.s || '').toUpperCase()) ? String(req.query.s).toUpperCase() : null;
  res.json({ name: pkg.name, version: pkg.version, tvs: sessions.size, ...urls(code) });
});

// a TV opens /watcher: keep its code if it still exists, otherwise hand out a new one
app.post('/api/tv', wrap(async (req) => {
  const wanted = String(req.body?.id || '').toUpperCase();
  const tv = store.tvExists(wanted) ? store.getTv(wanted) : store.createTv();
  if (tv.id !== wanted) console.log(`[TV ${tv.id}] neuer Fernseher angemeldet`);
  return { tv, ...urls(tv.id) };
}));

// the phone checks a code before pairing
app.get('/api/pair/:code', wrap(async (req) => {
  const code = String(req.params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!store.tvExists(code)) throw fail(404, `Kein TV mit dem Code ${code || '…'}`, 'no_tv');
  return { tv: store.getTv(code) };
}));

app.post('/api/tv/name', wrap(async (req) => {
  const s = sessionOf(req);
  const tv = store.renameTv(s.id, String(req.body?.name || '').trim());
  s.toWatchers('tv', { tv });
  s.pushState();
  return { tv };
}));

app.get('/api/qr.svg', async (req, res) => {
  try {
    const code = String(req.query.s || '').toUpperCase();
    const target = req.query.target === 'watcher' ? urls().watcherUrl : urls(store.isCode(code) ? code : null).controllerUrl;
    const svg = await QRCode.toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000ff', light: '#ffffff00' } });
    res.type('image/svg+xml').send(svg);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Content + playback, always within one TV session
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/search', wrap(async (req) => ({ results: await aw.search(req.query.q || '') })));
app.get('/api/state', wrap(async (req) => sessionOf(req).snapshot()));
app.get('/api/history', wrap(async (req) => { const s = sessionOf(req); return { history: store.getHistory(s.id, 30), stats: store.stats(s.id) }; }));
app.get('/api/progress/:slug', wrap(async (req) => ({ progress: store.getProgress(sessionOf(req).id, req.params.slug) })));
app.delete('/api/history/:slug', wrap(async (req) => { const s = sessionOf(req); store.remove(s.id, req.params.slug); s.pushState(); return { ok: true }; }));

app.post('/api/anime', wrap(async (req) => {
  const s = sessionOf(req);
  const r = await s.loadAnime(req.body.url || req.body.slug);
  s.pushState();
  return r;
}));

app.post('/api/season', wrap(async (req) => {
  const s = sessionOf(req);
  if (!req.body.href) throw fail(400, 'href fehlt');
  const episodes = await s.loadSeason(req.body.href);
  s.pushState();
  return { episodes, seasonHref: s.seasonHref };
}));

app.post('/api/play', wrap(async (req) => {
  const s = sessionOf(req);
  const { href, langKey, hosterName, hosterId, restart } = req.body || {};
  if (!href) throw fail(400, 'href fehlt');
  const r = await s.playEpisode(href, { langKey: langKey ? parseInt(langKey, 10) : undefined, hosterName, hosterId, restart: !!restart });
  return r || { superseded: true };
}));

app.post('/api/hoster', wrap(async (req) => (await sessionOf(req).switchHoster(req.body?.hosterId)) || { superseded: true }));
app.post('/api/next', wrap(async (req) => sessionOf(req).playNeighbour(1)));
app.post('/api/prev', wrap(async (req) => sessionOf(req).playNeighbour(-1)));
app.post('/api/stop', wrap(async (req) => { sessionOf(req).stop(); return { ok: true }; }));

app.post('/api/settings', wrap(async (req) => {
  const s = sessionOf(req);
  const patch = {};
  if (req.body.langKey != null) patch.langKey = parseInt(req.body.langKey, 10);
  if (req.body.autoplayNext != null) patch.autoplayNext = !!req.body.autoplayNext;
  if (req.body.profile != null) {
    const name = String(req.body.profile).trim();
    if (name && !/^[\w.-]{2,40}$/.test(name)) throw fail(400, 'Ungültiger AniWorld-Name');
    if (name) await aw.getProfile(name); // validate before saving
    patch.profile = name;
  }
  return { settings: s.setSettings(patch) };
}));

// the optional aniworld profile of this TV: recently watched, watchlist, subscriptions, watched episode links
app.get('/api/profile', wrap(async (req) => {
  const s = sessionOf(req);
  const name = (req.query.name || s.settings.profile || '').toString().trim();
  if (!name) return { profile: null };
  return { profile: await aw.getProfile(name) };
}));

// ─────────────────────────────────────────────────────────────────────────────
// Stream proxy – the TV's <video> loads everything through here so we can
// attach the hoster's Referer / User-Agent and sidestep CORS.
// ─────────────────────────────────────────────────────────────────────────────
const proxied = (url, referer) => `/api/proxy?r=${encodeURIComponent(referer || '')}&u=${encodeURIComponent(url)}`;

function rewritePlaylist(text, baseUrl, referer) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        // URI="…" inside EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA
        return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxied(new URL(u, baseUrl).href, referer)}"`);
      }
      try { return proxied(new URL(t, baseUrl).href, referer); } catch { return line; }
    })
    .join('\n');
}

app.get('/api/proxy', async (req, res) => {
  const target = req.query.u || req.query.url;
  const referer = req.query.r || req.query.referer || '';
  if (!target || !/^https?:\/\//i.test(target)) return res.status(400).send('Ungültige URL');

  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    const headers = { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.5' };
    if (referer) {
      headers.Referer = referer;
      try { headers.Origin = new URL(referer).origin; } catch { /* ignore */ }
    }
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = await request(target, { headers, signal: ac.signal, timeout: 30000 });
    const ct = upstream.headers.get('content-type') || '';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');

    const looksLikePlaylist = /mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(target) || /master\.txt(\?|$)/i.test(target);
    if (looksLikePlaylist || (/^text\//i.test(ct) && !req.headers.range)) {
      const text = await upstream.text();
      if (text.trimStart().startsWith('#EXTM3U')) {
        res.status(upstream.status).type('application/vnd.apple.mpegurl');
        return res.send(rewritePlaylist(text, upstream.url || target, referer));
      }
      res.status(upstream.status);
      if (ct) res.type(ct);
      return res.send(text);
    }

    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).on('error', () => res.end()).pipe(res);
  } catch (e) {
    if (ac.signal.aborted) return;
    console.error('[Proxy]', e.message);
    if (!res.headersSent) res.status(502).send(e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket: /?role=watcher|controller&s=<code>
// ─────────────────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://x').searchParams;
  const role = params.get('role');
  const s = getSession(params.get('s'));
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  if (!s) {
    ws.send(JSON.stringify({ type: 'no_tv' }));
    return ws.close(4004, 'unknown tv');
  }
  if (role === 'watcher') s.addWatcher(ws, urls(s.id));
  else if (role === 'controller') s.addController(ws);
  else ws.close(4001, 'role fehlt');
});

// drop dead sockets
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ─────────────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  const { watcherUrl, base } = urls();
  console.log(`\n  aniplay v${pkg.version} läuft`);
  console.log(`  📺 TV:             ${watcherUrl}   (jeder Fernseher bekommt einen eigenen Code)`);
  console.log(`  📱 Fernbedienung:  QR-Code auf dem TV scannen oder ${base}/controller öffnen und den Code eingeben\n`);
});
