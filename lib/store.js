/**
 * lib/store.js
 * ────────────
 * SQLite persistence (Node's built-in `node:sqlite`, no native build needed):
 *   settings   – preferred language, autoplay, aniworld profile …
 *   history    – one row per anime: last episode + position ("weiterschauen")
 *   progress   – one row per episode: position, duration, finished flag (resume any episode, ✓ marks)
 *   session    – what is loaded/playing right now, restored after a restart
 *
 * A legacy data/store.json is imported once and then renamed to store.json.imported.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'aniplay.sqlite');
const LEGACY_JSON = path.join(DATA_DIR, 'store.json');

const DEFAULT_SETTINGS = { langKey: 1, autoplayNext: true, volume: 1, profile: '' };
const FINISHED_AT = 0.93; // 93 % watched counts as finished (outro / preview)

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS history (
    slug TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    cover TEXT,
    season_href TEXT,
    season_num INTEGER,
    episode_href TEXT,
    episode_num INTEGER,
    episode_title TEXT,
    position REAL NOT NULL DEFAULT 0,
    duration REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS progress (
    episode_href TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    season_num INTEGER,
    episode_num INTEGER,
    position REAL NOT NULL DEFAULT 0,
    duration REAL NOT NULL DEFAULT 0,
    finished INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS progress_slug ON progress(slug);
  CREATE TABLE IF NOT EXISTS session (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, saved_at INTEGER NOT NULL);
`);

const q = {
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  allSettings: db.prepare('SELECT key, value FROM settings'),
  putSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  history: db.prepare('SELECT * FROM history ORDER BY updated_at DESC LIMIT ?'),
  historyOne: db.prepare('SELECT * FROM history WHERE slug = ?'),
  upsertHistory: db.prepare(`INSERT INTO history (slug, title, url, cover, season_href, season_num, episode_href, episode_num, episode_title, position, duration, updated_at)
    VALUES (@slug, @title, @url, @cover, @season_href, @season_num, @episode_href, @episode_num, @episode_title, @position, @duration, @updated_at)
    ON CONFLICT(slug) DO UPDATE SET title = excluded.title, url = excluded.url, cover = COALESCE(excluded.cover, history.cover),
      season_href = COALESCE(excluded.season_href, history.season_href), season_num = COALESCE(excluded.season_num, history.season_num),
      episode_href = COALESCE(excluded.episode_href, history.episode_href), episode_num = COALESCE(excluded.episode_num, history.episode_num),
      episode_title = COALESCE(excluded.episode_title, history.episode_title), position = excluded.position, duration = excluded.duration, updated_at = excluded.updated_at`),
  historyProgress: db.prepare('UPDATE history SET position = ?, duration = CASE WHEN ? > 0 THEN ? ELSE duration END, updated_at = ? WHERE slug = ?'),
  deleteHistory: db.prepare('DELETE FROM history WHERE slug = ?'),
  deleteProgress: db.prepare('DELETE FROM progress WHERE slug = ?'),
  trimHistory: db.prepare('DELETE FROM history WHERE slug IN (SELECT slug FROM history ORDER BY updated_at DESC LIMIT -1 OFFSET 100)'),
  progressOne: db.prepare('SELECT * FROM progress WHERE episode_href = ?'),
  progressBySlug: db.prepare('SELECT episode_href, season_num, episode_num, position, duration, finished, updated_at FROM progress WHERE slug = ?'),
  upsertProgress: db.prepare(`INSERT INTO progress (episode_href, slug, season_num, episode_num, position, duration, finished, updated_at)
    VALUES (@episode_href, @slug, @season_num, @episode_num, @position, @duration, @finished, @updated_at)
    ON CONFLICT(episode_href) DO UPDATE SET position = excluded.position, duration = CASE WHEN excluded.duration > 0 THEN excluded.duration ELSE progress.duration END,
      finished = MAX(progress.finished, excluded.finished), updated_at = excluded.updated_at`),
  getSession: db.prepare('SELECT json FROM session WHERE id = 1'),
  putSession: db.prepare('INSERT INTO session (id, json, saved_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, saved_at = excluded.saved_at'),
  clearSession: db.prepare('DELETE FROM session WHERE id = 1'),
  counts: db.prepare('SELECT (SELECT COUNT(*) FROM history) AS animes, (SELECT COUNT(*) FROM progress) AS episodes, (SELECT COUNT(*) FROM progress WHERE finished = 1) AS finished'),
};

const now = () => Date.now();

// ── settings ──
function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of q.allSettings.all()) {
    try { out[row.key] = JSON.parse(row.value); } catch { /* ignore */ }
  }
  return out;
}
function setSettings(patch) {
  const tx = db.prepare('BEGIN');
  tx.run();
  try {
    for (const [k, v] of Object.entries(patch)) q.putSetting.run(k, JSON.stringify(v));
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }
  return getSettings();
}

// ── history ("weiterschauen") ──
const rowToEntry = (r) =>
  r && {
    slug: r.slug,
    title: r.title,
    url: r.url,
    cover: r.cover,
    seasonHref: r.season_href,
    seasonNum: r.season_num,
    episodeHref: r.episode_href,
    episodeNum: r.episode_num,
    episodeTitle: r.episode_title,
    position: r.position,
    duration: r.duration,
    finished: r.duration > 0 && r.position >= r.duration * FINISHED_AT,
    updatedAt: r.updated_at,
  };

function getHistory(limit = 20) {
  return q.history.all(limit).map(rowToEntry);
}
function getEntry(slug) {
  return rowToEntry(q.historyOne.get(slug));
}

/** remember what is playing (called when an episode starts) */
function touch(anime, season, episode) {
  if (!anime?.slug) return;
  const prev = q.historyOne.get(anime.slug);
  const sameEpisode = prev && episode?.href && prev.episode_href === episode.href;
  const ep = episode?.href ? q.progressOne.get(episode.href) : null;
  q.upsertHistory.run({
    slug: anime.slug,
    title: anime.title,
    url: anime.url,
    cover: anime.cover || null,
    season_href: season?.href || null,
    season_num: episode?.seasonNum ?? season?.num ?? null,
    episode_href: episode?.href || null,
    episode_num: episode?.num ?? null,
    episode_title: episode?.title || null,
    position: sameEpisode ? prev.position : ep?.position || 0,
    duration: sameEpisode ? prev.duration : ep?.duration || 0,
    updated_at: now(),
  });
  q.trimHistory.run();
}

/** update playback position of the current episode (throttled by the caller) */
function progress(slug, episode, position, duration) {
  const pos = Math.max(0, Math.floor(position || 0));
  const dur = Math.max(0, Math.floor(duration || 0));
  const t = now();
  q.historyProgress.run(pos, dur, dur, t, slug);
  if (episode?.href) {
    q.upsertProgress.run({
      episode_href: episode.href,
      slug,
      season_num: episode.seasonNum ?? null,
      episode_num: episode.num ?? null,
      position: pos,
      duration: dur,
      finished: dur > 0 && pos >= dur * FINISHED_AT ? 1 : 0,
      updated_at: t,
    });
  }
}

/** mark an episode as fully watched (player reported "ended") */
function finish(slug, episode) {
  if (!episode?.href) return;
  const ep = q.progressOne.get(episode.href);
  const dur = ep?.duration || 0;
  q.upsertProgress.run({ episode_href: episode.href, slug, season_num: episode.seasonNum ?? null, episode_num: episode.num ?? null, position: dur, duration: dur, finished: 1, updated_at: now() });
  q.historyProgress.run(dur, dur, dur, now(), slug);
}

/** per-episode progress of one anime: { [href]: { position, duration, finished } } */
function getProgress(slug) {
  const out = {};
  for (const r of q.progressBySlug.all(slug)) {
    out[r.episode_href] = { position: r.position, duration: r.duration, finished: !!r.finished, updatedAt: r.updated_at };
  }
  return out;
}
function getEpisodeProgress(href) {
  const r = q.progressOne.get(href);
  return r ? { position: r.position, duration: r.duration, finished: !!r.finished } : null;
}

function remove(slug) {
  q.deleteHistory.run(slug);
  q.deleteProgress.run(slug);
}

// ── session ──
function getSession() {
  const r = q.getSession.get();
  if (!r) return null;
  try { return JSON.parse(r.json); } catch { return null; }
}
function setSession(session) {
  if (!session) q.clearSession.run();
  else q.putSession.run(JSON.stringify(session), now());
}

function stats() {
  return q.counts.get();
}

// ── one-time import of the old JSON store ──
(function importLegacy() {
  if (!fs.existsSync(LEGACY_JSON)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf8'));
    if (raw.settings) setSettings(raw.settings);
    for (const h of Object.values(raw.history || {})) {
      q.upsertHistory.run({
        slug: h.slug, title: h.title, url: h.url, cover: h.cover || null, season_href: h.seasonHref || null, season_num: h.seasonNum ?? null,
        episode_href: h.episodeHref || null, episode_num: h.episodeNum ?? null, episode_title: h.episodeTitle || null,
        position: h.position || 0, duration: h.duration || 0, updated_at: h.updatedAt || now(),
      });
      if (h.episodeHref) {
        q.upsertProgress.run({ episode_href: h.episodeHref, slug: h.slug, season_num: h.seasonNum ?? null, episode_num: h.episodeNum ?? null, position: h.position || 0, duration: h.duration || 0, finished: h.duration && h.position >= h.duration * FINISHED_AT ? 1 : 0, updated_at: h.updatedAt || now() });
      }
    }
    if (raw.session) setSession(raw.session);
    fs.renameSync(LEGACY_JSON, LEGACY_JSON + '.imported');
    console.log('[Store] store.json nach SQLite importiert');
  } catch (e) {
    console.warn('[Store] Import von store.json fehlgeschlagen:', e.message);
  }
})();

process.on('exit', () => { try { db.close(); } catch { /* ignore */ } });

module.exports = { getSettings, setSettings, getHistory, getEntry, touch, progress, finish, getProgress, getEpisodeProgress, remove, getSession, setSession, stats, DB_FILE };
