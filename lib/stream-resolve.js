/**
 * lib/stream-resolve.js
 * ─────────────────────
 * Turns the hoster list of an aniworld episode into a playable stream.
 *
 *   resolveHoster(hoster, episodeUrl)                 → StreamResult (one specific hoster)
 *   resolveEpisode(hosters, episodeUrl, prefs)        → StreamResult (best available)
 *   hosterOptions(hosters)                            → deduped list for the UI
 */

const { getWithFinalUrl } = require('./http');
const { getLoader } = require('./loaders/registry');

// language preference: Deutsch → GerSub → EngSub → English
const LANG_PREF = [1, 3, 2, 4];
// hoster preference: the ones that give us native HLS/MP4 come first,
// Doodstream last because it usually ends up as an iframe (Cloudflare).
const HOSTER_PREF = ['voe', 'vidmoly', 'filemoon', 'vidoza', 'streamtape', 'doodstream'];

const PER_HOSTER_TIMEOUT = 20000;

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label}: Zeitüberschreitung`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/** Follow aniworld's /redirect/<id> to the hoster's embed page URL. */
async function followRedirect(redirectUrl, episodeUrl) {
  const res = await getWithFinalUrl(redirectUrl, { headers: { Referer: episodeUrl }, timeout: 12000 });
  const finalUrl = res.url || redirectUrl;
  if (/aniworld\.to/i.test(new URL(finalUrl).hostname)) {
    // aniworld sometimes answers with an interstitial instead of redirecting
    const m = (res.text || '').match(/(?:window\.location(?:\.href)?|location\.href)\s*=\s*['"](https?:\/\/[^'"]+)['"]/);
    if (m) return m[1];
    throw new Error('Redirect führt nicht zum Hoster');
  }
  return finalUrl;
}

async function resolveHoster(hoster, episodeUrl) {
  const embedUrl = await followRedirect(hoster.redirectUrl, episodeUrl);
  const loader = getLoader(embedUrl, hoster.hosterName);
  if (!loader) throw new Error(`Kein Loader für ${embedUrl}`);
  console.log(`[Resolve] ${hoster.hosterName} (${hoster.langLabel || hoster.langKey}) → ${loader.name} @ ${embedUrl}`);
  const result = await withTimeout(loader.resolve(embedUrl, { referer: episodeUrl, hosterName: hoster.hosterName }), PER_HOSTER_TIMEOUT, hoster.hosterName);
  return {
    streamType: result.streamType,
    url: result.url,
    altUrl: result.altUrl || null,
    altType: result.altType || null,
    embedUrl: result.embedUrl || embedUrl,
    referer: result.referer || new URL(embedUrl).origin + '/',
    hosterName: result.hosterName || hoster.hosterName,
    langKey: hoster.langKey,
    langLabel: hoster.langLabel,
    hosterId: hoster.id,
  };
}

function rank(hosters, prefs = {}) {
  const langPref = prefs.langKey ? [prefs.langKey, ...LANG_PREF.filter((k) => k !== prefs.langKey)] : LANG_PREF;
  const hosterPref = prefs.hosterName
    ? [prefs.hosterName.toLowerCase(), ...HOSTER_PREF.filter((h) => h !== prefs.hosterName.toLowerCase())]
    : HOSTER_PREF;
  const idx = (arr, v, fallback = 99) => { const i = arr.indexOf(v); return i === -1 ? fallback : i; };
  return [...hosters].sort((a, b) => {
    const l = idx(langPref, a.langKey) - idx(langPref, b.langKey);
    if (l) return l;
    return idx(hosterPref, a.hosterName.toLowerCase()) - idx(hosterPref, b.hosterName.toLowerCase());
  });
}

/**
 * Try hosters in preference order until one yields a native stream.
 * Embeds are kept as a fallback. `exclude` = hoster ids that already failed on the TV.
 */
async function resolveEpisode(hosters, episodeUrl, prefs = {}) {
  const exclude = new Set(prefs.exclude || []);
  let list = rank(hosters, prefs).filter((h) => !exclude.has(h.id));
  // when the user explicitly picked a language, stay in that language
  if (prefs.langKey && prefs.strictLang) list = list.filter((h) => h.langKey === prefs.langKey);
  if (!list.length) throw new Error('Keine (weiteren) Hoster verfügbar');

  const errors = [];
  let embed = null;
  for (const hoster of list) {
    try {
      const r = await resolveHoster(hoster, episodeUrl);
      console.log(`[Resolve] ✓ ${hoster.hosterName}: ${r.streamType} ${String(r.url).slice(0, 90)}`);
      if (r.streamType === 'hls' || r.streamType === 'mp4') return r;
      if (!embed) embed = r;
    } catch (e) {
      console.warn(`[Resolve] ✗ ${hoster.hosterName}: ${e.message}`);
      errors.push(`${hoster.hosterName} (${hoster.langLabel}): ${e.message}`);
    }
  }
  if (embed) return embed;
  throw new Error('Alle Hoster fehlgeschlagen:\n' + errors.join('\n'));
}

/** Deduped hoster list for the UI, grouped by language. */
function hosterOptions(hosters) {
  const seen = new Set();
  return hosters
    .filter((h) => { const k = `${h.hosterName.toLowerCase()}:${h.langKey}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((h) => ({ id: h.id, hosterName: h.hosterName, langKey: h.langKey, langLabel: h.langLabel }));
}

module.exports = { resolveEpisode, resolveHoster, hosterOptions, LANG_PREF, HOSTER_PREF };
