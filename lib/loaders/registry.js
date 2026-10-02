/**
 * Loader Registry
 * ───────────────
 * Auto-discovers every *.js file in this folder (except registry.js).
 * Each loader exports:
 *   name     : string               → id, also matched against the hoster label from aniworld
 *   aliases  : string[]  (optional) → more hoster labels / domain fragments
 *   matches(url): boolean           → does this loader handle the embed URL?
 *   resolve(url, ctx): Promise<StreamResult>
 *
 * ctx = { referer, hosterName }
 * StreamResult = { streamType: 'hls'|'mp4'|'embed', url, embedUrl, hosterName, referer?, altUrl?, altType? }
 *
 * To add a hoster: drop a new file here. Done.
 */

const fs = require('fs');
const path = require('path');

const loaders = [];

for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith('.js') && f !== 'registry.js' && !f.startsWith('_')).sort()) {
  try {
    const loader = require(path.join(__dirname, file));
    if (typeof loader.matches === 'function' && typeof loader.resolve === 'function' && loader.name) {
      loaders.push(loader);
    } else {
      console.warn(`[Registry] ${file} übersprungen: name/matches()/resolve() fehlt`);
    }
  } catch (e) {
    console.error(`[Registry] Fehler beim Laden von ${file}:`, e.message);
  }
}
console.log(`[Registry] Loader: ${loaders.map((l) => l.name).join(', ')}`);

const generic = loaders.find((l) => l.name === 'generic') || null;
const specific = loaders.filter((l) => l.name !== 'generic');

/**
 * Pick a loader: first by the hoster label aniworld shows (VOE rotates domains,
 * so the URL alone is not reliable), then by URL, then the generic fallback.
 */
function getLoader(url, hosterName = '') {
  const label = String(hosterName || '').toLowerCase();
  if (label) {
    const byName = specific.find((l) => [l.name, ...(l.aliases || [])].some((a) => label.includes(String(a).toLowerCase())));
    if (byName) return byName;
  }
  const byUrl = specific.find((l) => l.matches(url));
  return byUrl || generic;
}

module.exports = { loaders, getLoader };
