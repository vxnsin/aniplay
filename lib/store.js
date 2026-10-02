/**
 * lib/store.js
 * ────────────
 * SQLite persistence (Node's built-in `node:sqlite`, no native build needed).
 * Everything belongs to one TV session (`sid`), so two TVs in the same home
 * keep separate history, progress and settings:
 *   tvs        – known sessions: code, name, last seen
 *   settings   – per session: preferred language, autoplay, aniworld profile …
 *   history    – per session, one row per anime: last episode + position ("weiterschauen")
 *   progress   – per session, one row per episode: position, duration, finished flag
 *   runtime    – per session: what is loaded/playing right now, restored after a restart
 *
 * Data from the single-session version is moved to a "legacy" session once and
 * handed to the first TV that registers afterwards (claimLegacy).
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'aniplay.sqlite');
const LEGACY = 'legacy';

const DEFAULT_SETTINGS = { langKey: 1, autoplayNext: true, volume: 1, profile: '' };
const FINISHED_AT = 0.93; // 93 % watched counts as finished (outro / preview)

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');

const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const tableExists = (table) => !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

// ── migrate the single-session schema (v1) ──
const needsMigration = tableExists('history') && !columns('history').includes('session_id');
if (needsMigration) {
  db.exec('BEGIN');
  try {
    db.exec(`
      ALTER TABLE settings RENAME TO settings_v1;
      ALTER TABLE history RENAME TO history_v1;
      ALTER TABLE progress RENAME TO progress_v1;
      DROP INDEX IF EXISTS progress_slug;
    `);
    if (tableExists('session')) db.exec('ALTER TABLE session RENAME TO session_v1;');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS tvs (id TEXT PRIMARY KEY, name TEXT, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (session_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (session_id, key));
  CREATE TABLE IF NOT EXISTS history (
    session_id TEXT NOT NULL,
    slug TEXT NOT NULL,
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
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, slug)
  );
  CREATE TABLE IF NOT EXISTS progress (
    session_id TEXT NOT NULL,
    episode_href TEXT NOT NULL,
    slug TEXT NOT NULL,
    season_num INTEGER,
    episode_num INTEGER,
    position REAL NOT NULL DEFAULT 0,
    duration REAL NOT NULL DEFAULT 0,
    finished INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, episode_href)
  );
  CREATE INDEX IF NOT EXISTS progress_slug ON progress(session_id, slug);
  CREATE TABLE IF NOT EXISTS runtime (session_id TEXT PRIMARY KEY, json TEXT NOT NULL, saved_at INTEGER NOT NULL);
`);

if (needsMigration) {
  const t = Date.now();
  db.exec('BEGIN');
  try {
    db.prepare('INSERT OR IGNORE INTO tvs (id, name, created_at, last_seen) VALUES (?, ?, ?, ?)').run(LEGACY, null, t, t);
    db.exec(`
      INSERT INTO settings (session_id, key, value) SELECT '${LEGACY}', key, value FROM settings_v1;
      INSERT INTO history SELECT '${LEGACY}', slug, title, url, cover, season_href, season_num, episode_href, episode_num, episode_title, position, duration, updated_at FROM history_v1;
      INSERT INTO progress SELECT '${LEGACY}', episode_href, slug, season_num, episode_num, position, duration, finished, updated_at FROM progress_v1;
      DROP TABLE settings_v1; DROP TABLE history_v1; DROP TABLE progress_v1;
    `);
    if (tableExists('session_v1')) {
      db.exec(`INSERT INTO runtime (session_id, json, saved_at) SELECT '${LEGACY}', json, saved_at FROM session_v1 WHERE id = 1; DROP TABLE session_v1;`);
    }
    db.exec('COMMIT');
    console.log('[Store] Daten der alten Einzel-Session übernommen – gehen an den ersten TV, der sich meldet');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const q = {
  tvGet: db.prepare('SELECT * FROM tvs WHERE id = ?'),
  tvInsert: db.prepare('INSERT INTO tvs (id, name, created_at, last_seen) VALUES (?, NULL, ?, ?)'),
  tvSeen: db.prepare('UPDATE tvs SET last_seen = ? WHERE id = ?'),
  tvName: db.prepare('UPDATE tvs SET name = ? WHERE id = ?'),
  tvCount: db.prepare('SELECT COUNT(*) AS n FROM tvs'),
  allSettings: db.prepare('SELECT key, value FROM settings WHERE session_id = ?'),
  putSetting: db.prepare('INSERT INTO settings (session_id, key, value) VALUES (?, ?, ?) ON CONFLICT(session_id, key) DO UPDATE SET value = excluded.value'),
  history: db.prepare('SELECT * FROM history WHERE session_id = ? ORDER BY updated_at DESC LIMIT ?'),
  historyOne: db.prepare('SELECT * FROM history WHERE session_id = ? AND slug = ?'),
  upsertHistory: db.prepare(`INSERT INTO history (session_id, slug, title, url, cover, season_href, season_num, episode_href, episode_num, episode_title, position, duration, updated_at)
    VALUES (@sid, @slug, @title, @url, @cover, @season_href, @season_num, @episode_href, @episode_num, @episode_title, @position, @duration, @updated_at)
    ON CONFLICT(session_id, slug) DO UPDATE SET title = excluded.title, url = excluded.url, cover = COALESCE(excluded.cover, history.cover),
      season_href = COALESCE(excluded.season_href, history.season_href), season_num = COALESCE(excluded.season_num, history.season_num),
      episode_href = COALESCE(excluded.episode_href, history.episode_href), episode_num = COALESCE(excluded.episode_num, history.episode_num),
      episode_title = COALESCE(excluded.episode_title, history.episode_title), position = excluded.position, duration = excluded.duration, updated_at = excluded.updated_at`),
  historyProgress: db.prepare('UPDATE history SET position = ?, duration = CASE WHEN ? > 0 THEN ? ELSE duration END, updated_at = ? WHERE session_id = ? AND slug = ?'),
  deleteHistory: db.prepare('DELETE FROM history WHERE session_id = ? AND slug = ?'),
  deleteProgress: db.prepare('DELETE FROM progress WHERE session_id = ? AND slug = ?'),
  trimHistory: db.prepare('DELETE FROM history WHERE session_id = ? AND slug IN (SELECT slug FROM history WHERE session_id = ? ORDER BY updated_at DESC LIMIT -1 OFFSET 100)'),
  progressOne: db.prepare('SELECT * FROM progress WHERE session_id = ? AND episode_href = ?'),
  progressBySlug: db.prepare('SELECT episode_href, position, duration, finished, updated_at FROM progress WHERE session_id = ? AND slug = ?'),
  upsertProgress: db.prepare(`INSERT INTO progress (session_id, episode_href, slug, season_num, episode_num, position, duration, finished, updated_at)
    VALUES (@sid, @episode_href, @slug, @season_num, @episode_num, @position, @duration, @finished, @updated_at)
    ON CONFLICT(session_id, episode_href) DO UPDATE SET position = excluded.position, duration = CASE WHEN excluded.duration > 0 THEN excluded.duration ELSE progress.duration END,
      finished = MAX(progress.finished, excluded.finished), updated_at = excluded.updated_at`),
  getRuntime: db.prepare('SELECT json FROM runtime WHERE session_id = ?'),
  putRuntime: db.prepare('INSERT INTO runtime (session_id, json, saved_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET json = excluded.json, saved_at = excluded.saved_at'),
  clearRuntime: db.prepare('DELETE FROM runtime WHERE session_id = ?'),
  counts: db.prepare('SELECT (SELECT COUNT(*) FROM history WHERE session_id = ?) AS animes, (SELECT COUNT(*) FROM progress WHERE session_id = ?) AS episodes, (SELECT COUNT(*) FROM progress WHERE session_id = ? AND finished = 1) AS finished'),
};

const now = () => Date.now();
const tx = (fn) => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};

// ── tv sessions ──
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I – easy to read off a TV
const isCode = (id) => typeof id === 'string' && /^[A-HJ-NP-Z2-9]{4}$/.test(id);

function tvExists(id) {
  return isCode(id) && !!q.tvGet.get(id);
}
function getTv(id) {
  const r = isCode(id) ? q.tvGet.get(id) : null;
  return r ? { id: r.id, name: r.name, createdAt: r.created_at, lastSeen: r.last_seen } : null;
}
function seenTv(id) {
  q.tvSeen.run(now(), id);
}
function renameTv(id, name) {
  q.tvName.run(name ? String(name).slice(0, 30) : null, id);
  return getTv(id);
}
/** a new TV: fresh code; the very first one after the update inherits the old single-session data */
function createTv() {
  let id;
  do {
    id = Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (q.tvGet.get(id));
  const t = now();
  tx(() => {
    q.tvInsert.run(id, t, t);
    if (q.tvGet.get(LEGACY)) {
      for (const table of ['settings', 'history', 'progress', 'runtime']) db.prepare(`UPDATE ${table} SET session_id = ? WHERE session_id = ?`).run(id, LEGACY);
      db.prepare('DELETE FROM tvs WHERE id = ?').run(LEGACY);
      console.log(`[Store] alter Verlauf geht an TV ${id}`);
    }
  });
  return getTv(id);
}

// ── settings ──
function getSettings(sid) {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of q.allSettings.all(sid)) {
    try { out[row.key] = JSON.parse(row.value); } catch { /* ignore */ }
  }
  return out;
}
function setSettings(sid, patch) {
  tx(() => { for (const [k, v] of Object.entries(patch)) q.putSetting.run(sid, k, JSON.stringify(v)); });
  return getSettings(sid);
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

function getHistory(sid, limit = 20) {
  return q.history.all(sid, limit).map(rowToEntry);
}
function getEntry(sid, slug) {
  return rowToEntry(q.historyOne.get(sid, slug));
}

/** remember what is playing (called when an episode starts) */
function touch(sid, anime, season, episode) {
  if (!anime?.slug) return;
  const prev = q.historyOne.get(sid, anime.slug);
  const sameEpisode = prev && episode?.href && prev.episode_href === episode.href;
  const ep = episode?.href ? q.progressOne.get(sid, episode.href) : null;
  q.upsertHistory.run({
    sid,
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
  q.trimHistory.run(sid, sid);
}

/** update playback position of the current episode (throttled by the caller) */
function progress(sid, slug, episode, position, duration) {
  const pos = Math.max(0, Math.floor(position || 0));
  const dur = Math.max(0, Math.floor(duration || 0));
  const t = now();
  q.historyProgress.run(pos, dur, dur, t, sid, slug);
  if (episode?.href) {
    q.upsertProgress.run({
      sid,
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
function finish(sid, slug, episode) {
  if (!episode?.href) return;
  const ep = q.progressOne.get(sid, episode.href);
  const dur = ep?.duration || 0;
  q.upsertProgress.run({ sid, episode_href: episode.href, slug, season_num: episode.seasonNum ?? null, episode_num: episode.num ?? null, position: dur, duration: dur, finished: 1, updated_at: now() });
  q.historyProgress.run(dur, dur, dur, now(), sid, slug);
}

/** per-episode progress of one anime: { [href]: { position, duration, finished } } */
function getProgress(sid, slug) {
  const out = {};
  for (const r of q.progressBySlug.all(sid, slug)) {
    out[r.episode_href] = { position: r.position, duration: r.duration, finished: !!r.finished, updatedAt: r.updated_at };
  }
  return out;
}
function getEpisodeProgress(sid, href) {
  const r = q.progressOne.get(sid, href);
  return r ? { position: r.position, duration: r.duration, finished: !!r.finished } : null;
}

function remove(sid, slug) {
  q.deleteHistory.run(sid, slug);
  q.deleteProgress.run(sid, slug);
}

// ── what is loaded right now ──
function getRuntime(sid) {
  const r = q.getRuntime.get(sid);
  if (!r) return null;
  try { return JSON.parse(r.json); } catch { return null; }
}
function setRuntime(sid, runtime) {
  if (!runtime) q.clearRuntime.run(sid);
  else q.putRuntime.run(sid, JSON.stringify(runtime), now());
}

function stats(sid) {
  return q.counts.get(sid, sid, sid);
}

process.on('exit', () => { try { db.close(); } catch { /* ignore */ } });

module.exports = {
  isCode, tvExists, getTv, seenTv, renameTv, createTv,
  getSettings, setSettings, getHistory, getEntry, touch, progress, finish, getProgress, getEpisodeProgress, remove,
  getRuntime, setRuntime, stats, DB_FILE,
};
