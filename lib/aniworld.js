/**
 * lib/aniworld.js
 * ───────────────
 * Everything that talks to aniworld.to:
 *   search(query)          → [{ title, slug, url, cover, description, year }]
 *   getSeries(urlOrSlug)   → { title, slug, url, cover, description, genres, rating, fsk, seasons[] }
 *   getSeason(href)        → [{ num, title, titleEn, href, langs[], hosters[] }]
 *   getEpisode(href)       → { title, titleEn, num, seasonNum, hosters[] }
 *
 * Parsing follows the markup aniworld.to serves today (verified 2026-10)
 * and mirrors the approach of phoenixthrush/AniWorld-Downloader:
 * plain HTML + regex/cheerio, no login, no cookies needed.
 */

const cheerio = require('cheerio');
const { getText, getJson } = require('./http');

const BASE = 'https://aniworld.to';

const AW_HEADERS = { Referer: `${BASE}/` };

// data-lang-key → label (see LANG_KEY_MAP in AniWorld-Downloader)
const LANGS = {
  1: { key: 1, label: 'Deutsch', short: 'DE', desc: 'Deutsche Synchro' },
  2: { key: 2, label: 'Eng Sub', short: 'EN-SUB', desc: 'Japanisch mit englischen Untertiteln' },
  3: { key: 3, label: 'Ger Sub', short: 'DE-SUB', desc: 'Japanisch mit deutschen Untertiteln' },
  4: { key: 4, label: 'English', short: 'EN', desc: 'Englische Synchro' },
};

// flag <img title="..."> on season pages → lang key
const FLAG_TITLE_TO_LANG = [
  [/deutsch\/german/i, 1],
  [/deutschem untertitel/i, 3],
  [/englischem untertitel|englisch(?!\/)/i, 2],
  [/english/i, 4],
];

// ── tiny in-memory cache so season/episode navigation feels instant ──
const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = fn();
  cache.set(key, { value, until: Date.now() + ttlMs });
  value.catch?.(() => cache.delete(key));
  return value;
}

function abs(href) {
  if (!href) return '';
  if (/^https?:\/\//i.test(href)) return href;
  return BASE + (href.startsWith('/') ? href : '/' + href);
}

function decodeEntities(str) {
  return cheerio.load(`<i>${str || ''}</i>`)('i').text().trim();
}

/** Accepts a full aniworld URL, a path, or a bare slug → { slug, url } */
function parseSeriesRef(input) {
  const s = String(input || '').trim();
  const m = s.match(/aniworld\.to\/anime\/stream\/([a-z0-9-]+)/i) || s.match(/^\/?anime\/stream\/([a-z0-9-]+)/i);
  const slug = m ? m[1] : /^[a-z0-9-]+$/i.test(s) ? s : null;
  if (!slug) throw new Error('Ungültiger AniWorld-Link oder Slug');
  return { slug: slug.toLowerCase(), url: `${BASE}/anime/stream/${slug.toLowerCase()}` };
}

// ── search ──────────────────────────────────────────────────────────────
async function search(query) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  return cached(`search:${q.toLowerCase()}`, 5 * 60_000, async () => {
    const data = await getJson(`${BASE}/ajax/seriesSearch?keyword=${encodeURIComponent(q)}`, {
      headers: { ...AW_HEADERS, 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!Array.isArray(data)) return [];
    return data.map((d) => ({
      title: decodeEntities(d.name),
      slug: d.link,
      url: `${BASE}/anime/stream/${d.link}`,
      cover: d.cover ? abs(d.cover) : null,
      description: decodeEntities(d.description),
      year: (d.productionYear || '').replace(/[()]/g, '').trim(),
    }));
  });
}

// ── series ──────────────────────────────────────────────────────────────
async function getSeries(input) {
  const { slug, url } = parseSeriesRef(input);
  return cached(`series:${slug}`, 10 * 60_000, async () => {
    const html = await getText(url, { headers: AW_HEADERS });
    const $ = cheerio.load(html);

    const title =
      $('.series-title h1 span').first().text().trim() ||
      $('.series-title h1').first().text().trim() ||
      $('title').text().split('|')[0].replace(/^Staffel \d+ von /i, '').trim();

    const coverEl = $('.seriesCoverBox img').first();
    const cover = abs(coverEl.attr('data-src') || coverEl.attr('src') || '');

    const description =
      $('[data-full-description]').attr('data-full-description')?.trim() ||
      $('.seri_des').text().trim() ||
      '';

    const genres = [];
    $('.genres [itemprop="genre"]').each((_, el) => genres.push($(el).text().trim()));

    const rating = $('[itemprop="ratingValue"]').first().text().trim() || null;
    const fsk = $('[data-fsk]').attr('data-fsk') || null;
    const start = $('[itemprop="startDate"]').first().text().trim() || $('[itemprop="startDate"]').attr('href')?.split('/').pop();
    const end = $('[itemprop="endDate"]').first().text().trim() || $('[itemprop="endDate"]').attr('href')?.split('/').pop();
    const year = start ? (end && end !== start ? `${start}–${end}` : start) : null;

    // seasons: every /staffel-N link on the page (deduped) + optional /filme
    const seasons = [];
    const seen = new Set();
    for (const m of html.matchAll(new RegExp(`href="(/anime/stream/${slug}/staffel-(\\d+))"`, 'g'))) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      seasons.push({ num: parseInt(m[2], 10), label: `Staffel ${m[2]}`, href: m[1] });
    }
    seasons.sort((a, b) => a.num - b.num);
    if (html.includes('title="Alle Filme">Filme</a>') || html.includes(`href="/anime/stream/${slug}/filme"`)) {
      seasons.push({ num: 0, label: 'Filme', href: `/anime/stream/${slug}/filme` });
    }
    if (!seasons.length) throw new Error('Keine Staffeln gefunden – ist der Link korrekt?');

    return { title, slug, url, cover: cover || null, description, genres, rating, fsk, year, seasons };
  });
}

// ── season → episodes ───────────────────────────────────────────────────
async function getSeason(href) {
  const path = href.replace(/^https?:\/\/[^/]+/, '');
  if (!/^\/anime\/stream\/[a-z0-9-]+\/(staffel-\d+|filme)\/?$/i.test(path)) throw new Error('Ungültiger Staffel-Link');
  return cached(`season:${path}`, 10 * 60_000, async () => {
    const html = await getText(abs(path), { headers: AW_HEADERS });
    const $ = cheerio.load(html);
    const isMovies = /\/filme\/?$/.test(path);
    const seasonNum = isMovies ? 0 : parseInt(path.match(/staffel-(\d+)/)[1], 10);
    const episodes = [];

    $('tr[itemtype="http://schema.org/Episode"]').each((_, tr) => {
      const row = $(tr);
      const link = row.find('a[itemprop="url"]').attr('href') || row.find('a[href*="/episode-"], a[href*="/film-"]').first().attr('href');
      if (!link) return;
      let num = parseInt(row.find('meta[itemprop="episodeNumber"]').attr('content') || '', 10);
      if (!Number.isFinite(num)) {
        const m = link.match(/(?:episode|film)-(\d+)/);
        num = m ? parseInt(m[1], 10) : episodes.length + 1;
      }
      const titleDe = row.find('.seasonEpisodeTitle strong').text().trim();
      const titleEn = row.find('.seasonEpisodeTitle span').text().trim();
      const langs = [];
      row.find('img.flag').each((__, img) => {
        const t = $(img).attr('title') || '';
        for (const [re, key] of FLAG_TITLE_TO_LANG) {
          if (re.test(t)) { if (!langs.includes(key)) langs.push(key); break; }
        }
      });
      const hosters = [];
      row.find('i.icon').each((__, i) => { const n = ($(i).attr('title') || '').trim(); if (n && !hosters.includes(n)) hosters.push(n); });
      episodes.push({
        num,
        seasonNum,
        title: titleDe || titleEn || (isMovies ? `Film ${num}` : `Episode ${num}`),
        titleEn: titleEn && titleEn !== titleDe ? titleEn : null,
        href: link,
        langs,
        hosters,
      });
    });

    episodes.sort((a, b) => a.num - b.num);
    return episodes;
  });
}

// ── episode → hosters ───────────────────────────────────────────────────
async function getEpisode(href) {
  const path = href.replace(/^https?:\/\/[^/]+/, '');
  if (!/^\/anime\/stream\/[a-z0-9-]+\/(staffel-\d+\/episode-\d+|filme\/film-\d+)\/?$/i.test(path)) throw new Error('Ungültiger Episoden-Link');
  // hoster redirect ids are stable, but keep the TTL short so new uploads show up
  return cached(`episode:${path}`, 3 * 60_000, async () => {
    const url = abs(path);
    const html = await getText(url, { headers: AW_HEADERS });
    const $ = cheerio.load(html);

    const title = $('.episodeGermanTitle').first().text().trim();
    const titleEn = $('.episodeEnglishTitle').first().text().trim();
    const num = parseInt((path.match(/(?:episode|film)-(\d+)/) || [])[1], 10);
    const seasonNum = /\/filme\//.test(path) ? 0 : parseInt((path.match(/staffel-(\d+)/) || [])[1], 10);

    const hosters = [];
    $('li[data-lang-key][data-link-target]').each((_, li) => {
      const el = $(li);
      const langKey = parseInt(el.attr('data-lang-key'), 10);
      const target = el.attr('data-link-target');
      const name = el.find('h4').first().text().trim() || el.find('i.icon').attr('title')?.replace(/^Hoster\s+/i, '') || 'Unbekannt';
      if (!target || !LANGS[langKey]) return;
      hosters.push({
        id: el.attr('data-link-id') || target.split('/').pop(),
        hosterName: name,
        langKey,
        langLabel: LANGS[langKey].label,
        redirectUrl: abs(target),
      });
    });
    if (!hosters.length) throw new Error('Keine Streams für diese Episode gefunden');

    return { url, href: path, title: title || titleEn || `Episode ${num}`, titleEn: titleEn || null, num, seasonNum, hosters };
  });
}

// ── public user profile ─────────────────────────────────────────────────
// aniworld.to/user/profil/<name>            → "<n> Episoden" in the header
// aniworld.to/user/profil/<name>/watched    → last ~1000 watched episodes (newest first)
// aniworld.to/user/profil/<name>/subscribed → subscribed animes
// aniworld.to/user/profil/<name>/watchlist  → watchlist
function parseCoverList(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('.coverListItem').each((_, el) => {
    const item = $(el);
    const href = item.find('a').first().attr('href') || '';
    const img = item.find('img').first();
    const src = img.attr('src') || '';
    const cover = img.attr('data-src') || (src.startsWith('data:') ? '' : src);
    const slug = (href.match(/\/anime\/stream\/([a-z0-9-]+)/i) || [])[1];
    if (!slug) return;
    out.push({
      title: item.find('h3').first().text().trim() || slug,
      genre: item.find('small').first().text().trim() || '',
      slug,
      url: `${BASE}/anime/stream/${slug}`,
      href,
      cover: cover ? abs(cover) : null,
      seasonNum: /\/filme\//.test(href) ? 0 : parseInt((href.match(/staffel-(\d+)/) || [])[1], 10) || null,
      episodeNum: parseInt((href.match(/(?:episode|film)-(\d+)/) || [])[1], 10) || null,
    });
  });
  return out;
}

async function getProfile(name) {
  const user = String(name || '').trim();
  if (!/^[\w.-]{2,40}$/.test(user)) throw new Error('Ungültiger AniWorld-Name');
  return cached(`profile:${user.toLowerCase()}`, 10 * 60_000, async () => {
    const base = `${BASE}/user/profil/${encodeURIComponent(user)}`;
    const [head, watched, subscribed, watchlist] = await Promise.all([
      getText(base, { headers: AW_HEADERS, timeout: 25000 }),
      getText(`${base}/watched`, { headers: AW_HEADERS, timeout: 25000 }).catch(() => ''),
      getText(`${base}/subscribed`, { headers: AW_HEADERS, timeout: 25000 }).catch(() => ''),
      getText(`${base}/watchlist`, { headers: AW_HEADERS, timeout: 25000 }).catch(() => ''),
    ]);
    if (/Benutzer nicht gefunden|user not found|404/i.test(head.slice(0, 3000)) && !/coverListItem|Episoden/.test(head)) {
      throw new Error(`AniWorld-Profil „${user}“ nicht gefunden`);
    }
    const episodes = parseInt(((head.match(/<span>\s*([\d.]+)\s*<\/span>\s*Episoden/) || [])[1] || '').replace(/\./g, ''), 10) || null;
    const watchedList = parseCoverList(watched);
    // the newest watched episode per anime
    const seenSlugs = new Set();
    const recent = watchedList.filter((w) => (seenSlugs.has(w.slug) ? false : (seenSlugs.add(w.slug), true))).slice(0, 24);
    return {
      name: user,
      url: base,
      episodes,
      recent,
      watchedHrefs: watchedList.map((w) => w.href),
      subscribed: parseCoverList(subscribed),
      watchlist: parseCoverList(watchlist),
      fetchedAt: new Date().toISOString(),
    };
  });
}

module.exports = { BASE, LANGS, search, getSeries, getSeason, getEpisode, getProfile, parseSeriesRef };
