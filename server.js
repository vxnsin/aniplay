/**
 * AniPlay – TV als Player, Handy als Fernbedienung.
 * server.js: Express + WebSocket, aniworld.to scraping, stream proxy, state.
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
const { resolveEpisode, resolveHoster, hosterOptions } = require('./lib/stream-resolve');
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

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  anime: null, // { title, slug, url, cover, description, genres, year, seasons[] }
  seasonHref: null,
  episodes: [], // of the selected season
  episode: null, // { href, num, seasonNum, title, titleEn }
  hosters: [], // all hoster entries of the current episode (raw, incl. redirectUrl)
  stream: null, // { url, streamType, embedUrl, hosterName, langKey, langLabel, hosterId, seekTo }
  playback: { isPlaying: false, currentTime: 0, duration: 0, volume: 1, muted: false },
  settings: store.getSettings(),
  busy: null, // string while loading something
  failedHosterIds: [],
  playSeq: 0,
};

// a restart (crash, nodemon, update) must not lose what the TV is playing: restore the last session
(function restoreSession() {
  const s = store.getSession();
  if (!s || !s.anime) return;
  Object.assign(state, {
    anime: s.anime,
    seasonHref: s.seasonHref || null,
    episodes: s.episodes || [],
    episode: s.episode || null,
    hosters: s.hosters || [],
    stream: s.stream || null,
  });
  const hist = store.getEntry(s.anime.slug);
  if (hist && s.episode && hist.episodeHref === s.episode.href) {
    state.playback.currentTime = hist.position || 0;
    state.playback.duration = hist.duration || 0;
  }
  console.log(`[State] Session wiederhergestellt: ${s.anime.title}${s.episode ? ` · ${s.episode.title}` : ''}`);
})();
function persistSession() {
  store.setSession(state.anime ? { anime: state.anime, seasonHref: state.seasonHref, episodes: state.episodes, episode: state.episode, hosters: state.hosters, stream: state.stream } : null);
}

// never die on a stray rejection; log it and keep serving the TV
process.on('unhandledRejection', (e) => console.error('[Unhandled]', e && e.stack ? e.stack : e));
process.on('uncaughtException', (e) => console.error('[Uncaught]', e && e.stack ? e.stack : e));

const watchers = new Set();
const controllers = new Set();

const send = (ws, type, data = {}) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...data }));
};
const toWatchers = (type, data) => watchers.forEach((ws) => send(ws, type, data));
const toControllers = (type, data) => controllers.forEach((ws) => send(ws, type, data));

/** what the phone needs to render everything */
function snapshot() {
  return {
    anime: state.anime,
    seasonHref: state.seasonHref,
    episodes: state.episodes,
    episode: state.episode,
    hosters: hosterOptions(state.hosters),
    progress: state.anime ? store.getProgress(state.anime.slug) : {},
    stream: state.stream && {
      hosterName: state.stream.hosterName,
      hosterId: state.stream.hosterId,
      streamType: state.stream.streamType,
      langKey: state.stream.langKey,
      langLabel: state.stream.langLabel,
    },
    playback: state.playback,
    settings: state.settings,
    busy: state.busy,
    watchers: watchers.size,
    controllers: controllers.size,
    history: store.getHistory(12),
  };
}
const pushState = () => toControllers('state', { state: snapshot() });

function setBusy(msg) {
  state.busy = msg || null;
  if (msg) toWatchers('status', { message: msg });
  else toWatchers('status', { message: '' });
  pushState();
}

function watcherStreamMessage(extra = {}) {
  if (!state.stream) return null;
  const s = state.stream;
  return {
    url: s.url,
    altUrl: s.altUrl || null,
    altType: s.altType || null,
    streamType: s.streamType,
    embedUrl: s.embedUrl,
    referer: s.referer,
    hosterName: s.hosterName,
    langLabel: s.langLabel,
    animeTitle: state.anime?.title || '',
    cover: state.anime?.cover || null,
    episode: state.episode,
    seekTo: 0,
    autoplay: true,
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────
async function loadAnime(input) {
  setBusy('Lade Anime …');
  try {
    const anime = await aw.getSeries(input);
    const hist = store.getEntry(anime.slug);
    const season =
      (hist?.seasonHref && anime.seasons.find((s) => s.href === hist.seasonHref)) ||
      anime.seasons.find((s) => s.num > 0) ||
      anime.seasons[0];
    const episodes = await aw.getSeason(season.href);
    Object.assign(state, { anime, seasonHref: season.href, episodes });
    persistSession();
    toWatchers('anime_loaded', { title: anime.title, cover: anime.cover });
    return { anime, seasonHref: season.href, episodes, resume: hist };
  } finally {
    setBusy(null);
  }
}

async function loadSeason(href) {
  setBusy('Lade Episoden …');
  try {
    const episodes = await aw.getSeason(href);
    state.seasonHref = href;
    state.episodes = episodes;
    persistSession();
    return episodes;
  } finally {
    setBusy(null);
  }
}

/**
 * Play an episode. opts: { langKey, hosterName, hosterId, restart, exclude }
 */
async function playEpisode(href, opts = {}) {
  const seq = ++state.playSeq;
  setBusy('Lade Stream …');
  try {
    const ep = await aw.getEpisode(href);
    if (seq !== state.playSeq) return null; // superseded by a newer request

    // keep anime/season in sync if the episode belongs to a different season than loaded
    const seasonMatch = ep.href.match(/^(\/anime\/stream\/[^/]+\/(?:staffel-\d+|filme))/);
    if (seasonMatch && seasonMatch[1] !== state.seasonHref) {
      try { state.episodes = await aw.getSeason(seasonMatch[1]); state.seasonHref = seasonMatch[1]; } catch { /* ignore */ }
    }
    if (!state.anime || !ep.href.includes(`/${state.anime.slug}/`)) {
      const slug = ep.href.split('/')[3];
      try { state.anime = await aw.getSeries(slug); } catch { /* ignore */ }
    }

    const langKey = opts.langKey || state.settings.langKey || 1;
    let stream;
    if (opts.hosterId) {
      const h = ep.hosters.find((x) => x.id === String(opts.hosterId));
      if (!h) throw new Error('Hoster nicht gefunden');
      stream = await resolveHoster(h, ep.url);
    } else {
      stream = await resolveEpisode(ep.hosters, ep.url, {
        langKey,
        hosterName: opts.hosterName,
        exclude: opts.exclude || [],
      });
    }
    if (seq !== state.playSeq) return null;

    // resume where this episode was left (per-episode progress in sqlite)
    const prog = store.getEpisodeProgress(ep.href);
    let seekTo = 0;
    if (!opts.restart && prog && !prog.finished && prog.position > 20 && (!prog.duration || prog.position < prog.duration * 0.93)) {
      seekTo = prog.position;
    }
    if (opts.seekTo != null) seekTo = opts.seekTo;

    state.episode = { href: ep.href, num: ep.num, seasonNum: ep.seasonNum, title: ep.title, titleEn: ep.titleEn };
    state.hosters = ep.hosters;
    state.stream = { ...stream, seekTo };
    state.playback = { ...state.playback, isPlaying: false, currentTime: seekTo, duration: prog?.duration || 0 };
    if (!opts.keepFailed) state.failedHosterIds = [];
    if (stream.hosterId && opts.exclude) state.failedHosterIds = [...opts.exclude];
    if (stream.langKey && stream.langKey !== state.settings.langKey && opts.langKey) {
      state.settings = store.setSettings({ langKey: stream.langKey });
    }

    const season = state.anime?.seasons.find((s) => s.href === state.seasonHref) || null;
    store.touch(state.anime, season, state.episode);
    persistSession();

    toWatchers('load_stream', watcherStreamMessage({ seekTo }));
    pushState();
    return { episode: state.episode, stream: snapshot().stream, seekTo };
  } finally {
    if (seq === state.playSeq) setBusy(null);
  }
}

function neighbourEpisode(dir) {
  if (!state.episode || !state.episodes.length) return null;
  const idx = state.episodes.findIndex((e) => e.href === state.episode.href);
  const next = state.episodes[idx + dir];
  if (next) return next.href;
  // roll over into the next / previous season
  if (state.anime) {
    const seasons = state.anime.seasons.filter((s) => s.num > 0).sort((a, b) => a.num - b.num);
    const si = seasons.findIndex((s) => s.href === state.seasonHref);
    const target = seasons[si + dir];
    if (target) return { seasonHref: target.href, pick: dir > 0 ? 'first' : 'last' };
  }
  return null;
}

async function playNeighbour(dir) {
  const n = neighbourEpisode(dir);
  if (!n) throw new Error(dir > 0 ? 'Das war die letzte Episode' : 'Das ist die erste Episode');
  if (typeof n === 'string') return playEpisode(n, { restart: true });
  const eps = await loadSeason(n.seasonHref);
  const ep = n.pick === 'first' ? eps[0] : eps[eps.length - 1];
  if (!ep) throw new Error('Keine Episoden in der Staffel');
  return playEpisode(ep.href, { restart: true });
}

function stopPlayback() {
  state.playSeq++;
  state.stream = null;
  state.episode = null;
  state.hosters = [];
  state.playback = { ...state.playback, isPlaying: false, currentTime: 0, duration: 0 };
  persistSession();
  toWatchers('stop', {});
  pushState();
}

// ─────────────────────────────────────────────────────────────────────────────
// REST API
// ─────────────────────────────────────────────────────────────────────────────
const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (e) {
    console.error(`[API] ${req.method} ${req.path}:`, e.message);
    res.status(e.status === 404 ? 404 : 500).json({ error: e.message });
  }
};

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name]) {
      if (i.family === 'IPv4' && !i.internal) candidates.push({ name, address: i.address });
    }
  }
  // prefer typical LAN ranges over virtual adapters
  const score = (c) => (/^192\.168\./.test(c.address) ? 3 : /^10\./.test(c.address) ? 2 : /^172\.(1[6-9]|2\d|3[01])\./.test(c.address) ? 1 : 0) - (/vEthernet|WSL|VirtualBox|VMware|Docker|Hyper-V/i.test(c.name) ? 5 : 0);
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0]?.address || 'localhost';
}

function urls(req) {
  const host = `${getLocalIP()}:${PORT}`;
  const proto = req?.protocol || 'http';
  return { host, watcherUrl: `${proto}://${host}/watcher`, controllerUrl: `${proto}://${host}/controller` };
}

app.get('/api/info', (req, res) => res.json({ name: pkg.name, version: pkg.version, ...urls(req), watchers: watchers.size, controllers: controllers.size }));

app.get('/api/qr.svg', async (req, res) => {
  try {
    const target = req.query.target === 'watcher' ? urls(req).watcherUrl : urls(req).controllerUrl;
    const svg = await QRCode.toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000ff', light: '#ffffff00' } });
    res.type('image/svg+xml').send(svg);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get('/api/state', (_req, res) => res.json(snapshot()));
app.get('/api/search', wrap(async (req) => ({ results: await aw.search(req.query.q || '') })));
app.get('/api/history', (_req, res) => res.json({ history: store.getHistory(30), stats: store.stats() }));
app.get('/api/progress/:slug', (req, res) => res.json({ progress: store.getProgress(req.params.slug) }));
app.delete('/api/history/:slug', (req, res) => { store.remove(req.params.slug); pushState(); res.json({ ok: true }); });

app.post('/api/anime', wrap(async (req) => {
  const r = await loadAnime(req.body.url || req.body.slug);
  pushState();
  return r;
}));

app.post('/api/season', wrap(async (req) => {
  if (!req.body.href) throw new Error('href fehlt');
  const episodes = await loadSeason(req.body.href);
  pushState();
  return { episodes, seasonHref: state.seasonHref };
}));

app.post('/api/play', wrap(async (req) => {
  const { href, langKey, hosterName, hosterId, restart } = req.body || {};
  if (!href) throw new Error('href fehlt');
  const r = await playEpisode(href, { langKey: langKey ? parseInt(langKey, 10) : undefined, hosterName, hosterId, restart: !!restart });
  return r || { superseded: true };
}));

app.post('/api/hoster', wrap(async (req) => {
  if (!state.episode) throw new Error('Es läuft keine Episode');
  const { hosterId } = req.body || {};
  const keepTime = state.playback.currentTime || 0;
  const r = await playEpisode(state.episode.href, { hosterId, seekTo: keepTime > 5 ? keepTime : 0, keepFailed: true });
  return r || { superseded: true };
}));

app.post('/api/next', wrap(async () => playNeighbour(1)));
app.post('/api/prev', wrap(async () => playNeighbour(-1)));
app.post('/api/stop', (_req, res) => { stopPlayback(); res.json({ ok: true }); });

app.post('/api/settings', wrap(async (req) => {
  const patch = {};
  if (req.body.langKey != null) patch.langKey = parseInt(req.body.langKey, 10);
  if (req.body.autoplayNext != null) patch.autoplayNext = !!req.body.autoplayNext;
  if (req.body.profile != null) {
    const name = String(req.body.profile).trim();
    if (name && !/^[\w.-]{2,40}$/.test(name)) throw new Error('Ungültiger AniWorld-Name');
    if (name) await aw.getProfile(name); // validate before saving
    patch.profile = name;
  }
  state.settings = store.setSettings(patch);
  pushState();
  return { settings: state.settings };
}));

// the optional aniworld profile: recently watched, watchlist, subscriptions, watched episode links
app.get('/api/profile', wrap(async (req) => {
  const name = (req.query.name || state.settings.profile || '').toString().trim();
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
// WebSocket
// ─────────────────────────────────────────────────────────────────────────────
let lastProgressWrite = 0;
let endedHandledFor = null;
let autoFallbackCount = 0;

function syncWatcher(ws) {
  send(ws, 'sync_state', {
    animeTitle: state.anime?.title || '',
    cover: state.anime?.cover || null,
    controllers: controllers.size,
    ...urls(),
  });
  if (state.stream && state.episode) {
    send(ws, 'load_stream', watcherStreamMessage({ seekTo: state.playback.currentTime || 0, autoplay: state.playback.isPlaying }));
  }
}

async function handleWatcherMessage(ws, msg) {
  const pb = state.playback;
  switch (msg.type) {
    case 'playing':
      pb.isPlaying = true;
      endedHandledFor = null;
      toControllers('playback', { playback: pb });
      break;
    case 'paused':
      pb.isPlaying = false;
      toControllers('playback', { playback: pb });
      break;
    case 'timeupdate': {
      if (!state.episode) return; // nothing loaded on our side (fresh restart without a saved session)
      if (typeof msg.currentTime === 'number') pb.currentTime = msg.currentTime;
      if (typeof msg.duration === 'number' && msg.duration > 0) pb.duration = msg.duration;
      if (typeof msg.volume === 'number') pb.volume = msg.volume;
      if (typeof msg.muted === 'boolean') pb.muted = msg.muted;
      toControllers('playback', { playback: pb });
      const now = Date.now();
      if (state.anime && now - lastProgressWrite > 5000) {
        lastProgressWrite = now;
        store.progress(state.anime.slug, state.episode, pb.currentTime, pb.duration);
      }
      break;
    }
    case 'ended': {
      pb.isPlaying = false;
      toControllers('playback', { playback: pb });
      if (state.anime) store.finish(state.anime.slug, state.episode);
      pushState();
      const key = state.episode?.href;
      if (state.settings.autoplayNext && key && endedHandledFor !== key) {
        endedHandledFor = key;
        const n = neighbourEpisode(1);
        if (n) {
          toWatchers('up_next', { episode: typeof n === 'string' ? state.episodes.find((e) => e.href === n) : null, seconds: 8 });
          setTimeout(() => {
            if (endedHandledFor !== key || state.episode?.href !== key) return;
            playNeighbour(1).catch((e) => toControllers('toast', { message: e.message }));
          }, 8000);
        }
      }
      break;
    }
    case 'player_error': {
      // the TV could not play this source → try the next hoster automatically
      if (!state.episode || !state.stream) return;
      const failedId = state.stream.hosterId;
      if (autoFallbackCount >= 4) {
        toControllers('toast', { message: 'Kein Hoster spielt diese Episode ab (╥﹏╥)' });
        return;
      }
      autoFallbackCount++;
      const exclude = [...new Set([...(state.failedHosterIds || []), failedId].filter(Boolean))];
      console.warn(`[Watcher] Player-Fehler bei ${state.stream.hosterName}: ${msg.message || ''} → wechsle Hoster`);
      toControllers('toast', { message: `${state.stream.hosterName} spielt nicht – wechsle Hoster …` });
      try {
        await playEpisode(state.episode.href, { exclude, keepFailed: true, seekTo: pb.currentTime > 5 ? pb.currentTime : 0, langKey: state.stream.langKey });
      } catch (e) {
        toControllers('toast', { message: e.message.split('\n')[0] });
        toWatchers('status', { message: 'Kein Hoster verfügbar' });
      }
      break;
    }
    case 'ready':
      autoFallbackCount = 0;
      break;
    case 'ping':
      break;
    default:
      break;
  }
}

function handleControllerMessage(ws, msg) {
  switch (msg.type) {
    case 'play':
    case 'pause':
    case 'toggle':
    case 'fullscreen':
    case 'mute':
      toWatchers(msg.type, msg);
      break;
    case 'seek':
      toWatchers('seek', { delta: Number(msg.delta) || 0 });
      break;
    case 'seek_to':
      toWatchers('seek_to', { time: Math.max(0, Number(msg.time) || 0) });
      state.playback.currentTime = Math.max(0, Number(msg.time) || 0);
      break;
    case 'volume':
      state.playback.volume = Math.max(0, Math.min(1, Number(msg.value)));
      toWatchers('volume', { value: state.playback.volume });
      break;
    case 'sync':
      toWatchers('seek_to', { time: state.playback.currentTime, resume: state.playback.isPlaying });
      break;
    case 'next':
      playNeighbour(1).catch((e) => send(ws, 'toast', { message: e.message }));
      break;
    case 'prev':
      playNeighbour(-1).catch((e) => send(ws, 'toast', { message: e.message }));
      break;
    case 'stop':
      stopPlayback();
      break;
    case 'get_state':
      send(ws, 'state', { state: snapshot() });
      break;
    default:
      break;
  }
}

wss.on('connection', (ws, req) => {
  const role = new URL(req.url, 'http://x').searchParams.get('role');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (role === 'watcher') {
    watchers.add(ws);
    console.log(`[WS] TV verbunden (${watchers.size})`);
    send(ws, 'connected', { role: 'watcher' });
    syncWatcher(ws);
    pushState();
    ws.on('message', (raw) => { try { handleWatcherMessage(ws, JSON.parse(raw)).catch((e) => console.error('[WS watcher]', e.message)); } catch { /* ignore */ } });
    ws.on('close', () => { watchers.delete(ws); console.log(`[WS] TV getrennt (${watchers.size})`); pushState(); });
  } else if (role === 'controller') {
    controllers.add(ws);
    console.log(`[WS] Fernbedienung verbunden (${controllers.size})`);
    send(ws, 'connected', { role: 'controller' });
    send(ws, 'state', { state: snapshot() });
    toWatchers('controllers', { count: controllers.size });
    ws.on('message', (raw) => { try { handleControllerMessage(ws, JSON.parse(raw)); } catch { /* ignore */ } });
    ws.on('close', () => { controllers.delete(ws); console.log(`[WS] Fernbedienung getrennt (${controllers.size})`); toWatchers('controllers', { count: controllers.size }); pushState(); });
  } else {
    ws.close(4001, 'role fehlt');
  }
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
  const { watcherUrl, controllerUrl } = urls();
  console.log(`\n  aniplay v${pkg.version} läuft`);
  console.log(`  📺 TV:             ${watcherUrl}`);
  console.log(`  📱 Fernbedienung:  ${controllerUrl}\n`);
});
