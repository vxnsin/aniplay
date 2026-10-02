/**
 * lib/session.js
 * ──────────────
 * One Session per TV. A TV gets a 4-character code; its QR code points phones
 * at exactly this session, so two TVs in the same WLAN never control each other.
 * Everything that used to be global (what is playing, which sockets are
 * connected, history, settings) lives here, keyed by the session id.
 */

const WebSocket = require('ws');
const aw = require('./aniworld');
const store = require('./store');
const { resolveEpisode, resolveHoster, hosterOptions } = require('./stream-resolve');

const sessions = new Map();

const send = (ws, type, data = {}) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...data }));
};

class Session {
  constructor(id) {
    this.id = id;
    this.watchers = new Set();
    this.controllers = new Set();
    this.anime = null; // { title, slug, url, cover, description, genres, year, seasons[] }
    this.seasonHref = null;
    this.episodes = []; // of the selected season
    this.episode = null; // { href, num, seasonNum, title, titleEn }
    this.hosters = []; // all hoster entries of the current episode (raw, incl. redirectUrl)
    this.stream = null; // resolved stream + seekTo
    this.playback = { isPlaying: false, currentTime: 0, duration: 0, volume: 1, muted: false };
    this.settings = store.getSettings(id);
    this.busy = null;
    this.failedHosterIds = [];
    this.playSeq = 0;
    this.lastProgressWrite = 0;
    this.endedHandledFor = null;
    this.autoFallbackCount = 0;
    this.restore();
  }

  get tv() {
    return store.getTv(this.id);
  }

  // ── persistence: a restart must not lose what the TV is playing ──
  restore() {
    const s = store.getRuntime(this.id);
    if (!s || !s.anime) return;
    Object.assign(this, {
      anime: s.anime,
      seasonHref: s.seasonHref || null,
      episodes: s.episodes || [],
      episode: s.episode || null,
      hosters: s.hosters || [],
      stream: s.stream || null,
    });
    const prog = s.episode ? store.getEpisodeProgress(this.id, s.episode.href) : null;
    if (prog) {
      this.playback.currentTime = prog.position || 0;
      this.playback.duration = prog.duration || 0;
    }
    console.log(`[TV ${this.id}] wiederhergestellt: ${s.anime.title}${s.episode ? ` · ${s.episode.title}` : ''}`);
  }
  persist() {
    store.setRuntime(this.id, this.anime ? { anime: this.anime, seasonHref: this.seasonHref, episodes: this.episodes, episode: this.episode, hosters: this.hosters, stream: this.stream } : null);
  }

  // ── messaging ──
  toWatchers(type, data) { this.watchers.forEach((ws) => send(ws, type, data)); }
  toControllers(type, data) { this.controllers.forEach((ws) => send(ws, type, data)); }

  /** what the phone needs to render everything */
  snapshot() {
    return {
      tv: this.tv,
      anime: this.anime,
      seasonHref: this.seasonHref,
      episodes: this.episodes,
      episode: this.episode,
      hosters: hosterOptions(this.hosters),
      progress: this.anime ? store.getProgress(this.id, this.anime.slug) : {},
      stream: this.stream && {
        hosterName: this.stream.hosterName,
        hosterId: this.stream.hosterId,
        streamType: this.stream.streamType,
        langKey: this.stream.langKey,
        langLabel: this.stream.langLabel,
      },
      playback: this.playback,
      settings: this.settings,
      busy: this.busy,
      watchers: this.watchers.size,
      controllers: this.controllers.size,
      history: store.getHistory(this.id, 12),
    };
  }
  pushState() { this.toControllers('state', { state: this.snapshot() }); }

  setBusy(msg) {
    this.busy = msg || null;
    this.toWatchers('status', { message: msg || '' });
    this.pushState();
  }

  watcherStreamMessage(extra = {}) {
    if (!this.stream) return null;
    const s = this.stream;
    return {
      url: s.url,
      altUrl: s.altUrl || null,
      altType: s.altType || null,
      streamType: s.streamType,
      embedUrl: s.embedUrl,
      referer: s.referer,
      hosterName: s.hosterName,
      langLabel: s.langLabel,
      animeTitle: this.anime?.title || '',
      cover: this.anime?.cover || null,
      episode: this.episode,
      seekTo: 0,
      autoplay: true,
      ...extra,
    };
  }

  setSettings(patch) {
    this.settings = store.setSettings(this.id, patch);
    this.pushState();
    return this.settings;
  }

  // ── actions ──
  async loadAnime(input) {
    this.setBusy('Lade Anime …');
    try {
      const anime = await aw.getSeries(input);
      const hist = store.getEntry(this.id, anime.slug);
      const season =
        (hist?.seasonHref && anime.seasons.find((s) => s.href === hist.seasonHref)) ||
        anime.seasons.find((s) => s.num > 0) ||
        anime.seasons[0];
      const episodes = await aw.getSeason(season.href);
      Object.assign(this, { anime, seasonHref: season.href, episodes });
      this.persist();
      this.toWatchers('anime_loaded', { title: anime.title, cover: anime.cover });
      return { anime, seasonHref: season.href, episodes, resume: hist };
    } finally {
      this.setBusy(null);
    }
  }

  async loadSeason(href) {
    this.setBusy('Lade Episoden …');
    try {
      const episodes = await aw.getSeason(href);
      this.seasonHref = href;
      this.episodes = episodes;
      this.persist();
      return episodes;
    } finally {
      this.setBusy(null);
    }
  }

  /** Play an episode. opts: { langKey, hosterName, hosterId, restart, exclude, seekTo, keepFailed } */
  async playEpisode(href, opts = {}) {
    const seq = ++this.playSeq;
    this.setBusy('Lade Stream …');
    try {
      const ep = await aw.getEpisode(href);
      if (seq !== this.playSeq) return null; // superseded by a newer request

      // keep anime/season in sync if the episode belongs to a different season than loaded
      const seasonMatch = ep.href.match(/^(\/anime\/stream\/[^/]+\/(?:staffel-\d+|filme))/);
      if (seasonMatch && seasonMatch[1] !== this.seasonHref) {
        try { this.episodes = await aw.getSeason(seasonMatch[1]); this.seasonHref = seasonMatch[1]; } catch { /* ignore */ }
      }
      if (!this.anime || !ep.href.includes(`/${this.anime.slug}/`)) {
        try { this.anime = await aw.getSeries(ep.href.split('/')[3]); } catch { /* ignore */ }
      }

      const langKey = opts.langKey || this.settings.langKey || 1;
      let stream;
      if (opts.hosterId) {
        const h = ep.hosters.find((x) => x.id === String(opts.hosterId));
        if (!h) throw new Error('Hoster nicht gefunden');
        stream = await resolveHoster(h, ep.url);
      } else {
        stream = await resolveEpisode(ep.hosters, ep.url, { langKey, hosterName: opts.hosterName, exclude: opts.exclude || [] });
      }
      if (seq !== this.playSeq) return null;

      // resume where this episode was left
      const prog = store.getEpisodeProgress(this.id, ep.href);
      let seekTo = 0;
      if (!opts.restart && prog && !prog.finished && prog.position > 20 && (!prog.duration || prog.position < prog.duration * 0.93)) seekTo = prog.position;
      if (opts.seekTo != null) seekTo = opts.seekTo;

      this.episode = { href: ep.href, num: ep.num, seasonNum: ep.seasonNum, title: ep.title, titleEn: ep.titleEn };
      this.hosters = ep.hosters;
      this.stream = { ...stream, seekTo };
      this.playback = { ...this.playback, isPlaying: false, currentTime: seekTo, duration: prog?.duration || 0 };
      if (!opts.keepFailed) this.failedHosterIds = [];
      if (stream.hosterId && opts.exclude) this.failedHosterIds = [...opts.exclude];
      if (stream.langKey && stream.langKey !== this.settings.langKey && opts.langKey) this.settings = store.setSettings(this.id, { langKey: stream.langKey });

      const season = this.anime?.seasons.find((s) => s.href === this.seasonHref) || null;
      store.touch(this.id, this.anime, season, this.episode);
      this.persist();

      this.toWatchers('load_stream', this.watcherStreamMessage({ seekTo }));
      this.pushState();
      return { episode: this.episode, stream: this.snapshot().stream, seekTo };
    } finally {
      if (seq === this.playSeq) this.setBusy(null);
    }
  }

  async switchHoster(hosterId) {
    if (!this.episode) throw new Error('Es läuft keine Episode');
    const keepTime = this.playback.currentTime || 0;
    return this.playEpisode(this.episode.href, { hosterId, seekTo: keepTime > 5 ? keepTime : 0, keepFailed: true });
  }

  neighbourEpisode(dir) {
    if (!this.episode || !this.episodes.length) return null;
    const idx = this.episodes.findIndex((e) => e.href === this.episode.href);
    const next = this.episodes[idx + dir];
    if (next) return next.href;
    // roll over into the next / previous season
    if (this.anime) {
      const seasons = this.anime.seasons.filter((s) => s.num > 0).sort((a, b) => a.num - b.num);
      const si = seasons.findIndex((s) => s.href === this.seasonHref);
      const target = seasons[si + dir];
      if (target) return { seasonHref: target.href, pick: dir > 0 ? 'first' : 'last' };
    }
    return null;
  }

  async playNeighbour(dir) {
    const n = this.neighbourEpisode(dir);
    if (!n) throw new Error(dir > 0 ? 'Das war die letzte Episode' : 'Das ist die erste Episode');
    if (typeof n === 'string') return this.playEpisode(n, { restart: true });
    const eps = await this.loadSeason(n.seasonHref);
    const ep = n.pick === 'first' ? eps[0] : eps[eps.length - 1];
    if (!ep) throw new Error('Keine Episoden in der Staffel');
    return this.playEpisode(ep.href, { restart: true });
  }

  stop() {
    this.playSeq++;
    this.stream = null;
    this.episode = null;
    this.hosters = [];
    this.playback = { ...this.playback, isPlaying: false, currentTime: 0, duration: 0 };
    this.persist();
    this.toWatchers('stop', {});
    this.pushState();
  }

  // ── sockets ──
  addWatcher(ws, info) {
    this.watchers.add(ws);
    store.seenTv(this.id);
    console.log(`[TV ${this.id}] TV verbunden (${this.watchers.size})`);
    send(ws, 'connected', { role: 'watcher', tv: this.tv });
    send(ws, 'sync_state', { animeTitle: this.anime?.title || '', cover: this.anime?.cover || null, controllers: this.controllers.size, tv: this.tv, ...info });
    if (this.stream && this.episode) send(ws, 'load_stream', this.watcherStreamMessage({ seekTo: this.playback.currentTime || 0, autoplay: this.playback.isPlaying }));
    this.pushState();
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      this.onWatcherMessage(msg).catch((e) => console.error(`[TV ${this.id}]`, e.message));
    });
    ws.on('close', () => {
      this.watchers.delete(ws);
      console.log(`[TV ${this.id}] TV getrennt (${this.watchers.size})`);
      this.pushState();
    });
  }

  addController(ws) {
    this.controllers.add(ws);
    console.log(`[TV ${this.id}] Fernbedienung verbunden (${this.controllers.size})`);
    send(ws, 'connected', { role: 'controller', tv: this.tv });
    send(ws, 'state', { state: this.snapshot() });
    this.toWatchers('controllers', { count: this.controllers.size });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      this.onControllerMessage(ws, msg);
    });
    ws.on('close', () => {
      this.controllers.delete(ws);
      console.log(`[TV ${this.id}] Fernbedienung getrennt (${this.controllers.size})`);
      this.toWatchers('controllers', { count: this.controllers.size });
      this.pushState();
    });
  }

  async onWatcherMessage(msg) {
    const pb = this.playback;
    switch (msg.type) {
      case 'playing':
        pb.isPlaying = true;
        this.endedHandledFor = null;
        this.toControllers('playback', { playback: pb });
        break;
      case 'paused':
        pb.isPlaying = false;
        this.toControllers('playback', { playback: pb });
        break;
      case 'timeupdate': {
        if (!this.episode) return;
        if (typeof msg.currentTime === 'number') pb.currentTime = msg.currentTime;
        if (typeof msg.duration === 'number' && msg.duration > 0) pb.duration = msg.duration;
        if (typeof msg.volume === 'number') pb.volume = msg.volume;
        if (typeof msg.muted === 'boolean') pb.muted = msg.muted;
        this.toControllers('playback', { playback: pb });
        const now = Date.now();
        if (this.anime && now - this.lastProgressWrite > 5000) {
          this.lastProgressWrite = now;
          store.progress(this.id, this.anime.slug, this.episode, pb.currentTime, pb.duration);
        }
        break;
      }
      case 'ended': {
        pb.isPlaying = false;
        this.toControllers('playback', { playback: pb });
        if (this.anime) store.finish(this.id, this.anime.slug, this.episode);
        this.pushState();
        const key = this.episode?.href;
        if (this.settings.autoplayNext && key && this.endedHandledFor !== key) {
          this.endedHandledFor = key;
          const n = this.neighbourEpisode(1);
          if (n) {
            this.toWatchers('up_next', { episode: typeof n === 'string' ? this.episodes.find((e) => e.href === n) : null, seconds: 8 });
            setTimeout(() => {
              if (this.endedHandledFor !== key || this.episode?.href !== key) return;
              this.playNeighbour(1).catch((e) => this.toControllers('toast', { message: e.message }));
            }, 8000);
          }
        }
        break;
      }
      case 'player_error': {
        // the TV could not play this source → try the next hoster automatically
        if (!this.episode || !this.stream) return;
        if (this.autoFallbackCount >= 4) {
          this.toControllers('toast', { message: 'Kein Hoster spielt diese Episode ab (╥﹏╥)' });
          return;
        }
        this.autoFallbackCount++;
        const exclude = [...new Set([...(this.failedHosterIds || []), this.stream.hosterId].filter(Boolean))];
        console.warn(`[TV ${this.id}] Player-Fehler bei ${this.stream.hosterName}: ${msg.message || ''} → wechsle Hoster`);
        this.toControllers('toast', { message: `${this.stream.hosterName} spielt nicht – wechsle Hoster …` });
        try {
          await this.playEpisode(this.episode.href, { exclude, keepFailed: true, seekTo: pb.currentTime > 5 ? pb.currentTime : 0, langKey: this.stream.langKey });
        } catch (e) {
          this.toControllers('toast', { message: e.message.split('\n')[0] });
          this.toWatchers('status', { message: 'Kein Hoster verfügbar' });
        }
        break;
      }
      case 'ready':
        this.autoFallbackCount = 0;
        break;
      default:
        break;
    }
  }

  onControllerMessage(ws, msg) {
    switch (msg.type) {
      case 'play':
      case 'pause':
      case 'toggle':
      case 'fullscreen':
      case 'mute':
        this.toWatchers(msg.type, msg);
        break;
      case 'seek':
        this.toWatchers('seek', { delta: Number(msg.delta) || 0 });
        break;
      case 'seek_to':
        this.toWatchers('seek_to', { time: Math.max(0, Number(msg.time) || 0) });
        this.playback.currentTime = Math.max(0, Number(msg.time) || 0);
        break;
      case 'volume':
        this.playback.volume = Math.max(0, Math.min(1, Number(msg.value)));
        this.toWatchers('volume', { value: this.playback.volume });
        break;
      case 'sync':
        this.toWatchers('seek_to', { time: this.playback.currentTime, resume: this.playback.isPlaying });
        break;
      case 'next':
        this.playNeighbour(1).catch((e) => send(ws, 'toast', { message: e.message }));
        break;
      case 'prev':
        this.playNeighbour(-1).catch((e) => send(ws, 'toast', { message: e.message }));
        break;
      case 'stop':
        this.stop();
        break;
      case 'get_state':
        send(ws, 'state', { state: this.snapshot() });
        break;
      default:
        break;
    }
  }
}

/** the session of a known TV code, or null */
function getSession(id) {
  const code = String(id || '').toUpperCase();
  if (!store.tvExists(code)) return null;
  let s = sessions.get(code);
  if (!s) {
    s = new Session(code);
    sessions.set(code, s);
  }
  return s;
}

// forget idle sessions after a while (their state stays in sqlite)
setInterval(() => {
  for (const [id, s] of sessions) if (!s.watchers.size && !s.controllers.size) sessions.delete(id);
}, 15 * 60_000).unref();

module.exports = { getSession, sessions };
