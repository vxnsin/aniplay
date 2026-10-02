/**
 * Loader: Doodstream (dood.*, playmogo.com, d0o0d, ds2play, …)
 * ─────────────────────────────────────────────────────────────
 * Direct link = {pass_md5 response}{10 random chars}?token={token}&expiry={now}
 * The CDN binds the link to the User-Agent that created it, so playback must
 * go through our proxy (same UA) with Referer https://dood.li/.
 *
 * Doodstream currently fronts its domains with a Cloudflare challenge that
 * plain HTTP clients cannot pass. When we hit it we fall back to embedding
 * the /e/ player in an iframe (a real browser can solve the challenge).
 */

const { getWithFinalUrl, getText, isChallengePage } = require('../http');

const name = 'doodstream';
const aliases = ['doodstream', 'dood'];

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function matches(url) {
  return /dood(?:stream)?\.|d0o0d|ds2play|ds2video|playmogo\.com|do7go|dooood|doodcdn|myvidplay|vidply/i.test(url);
}

function random(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += CHARS[Math.floor(Math.random() * CHARS.length)];
  return s;
}

async function resolve(url, ctx = {}) {
  const embedUrl = url.replace(/\/d\//, '/e/').replace(/\/f\//, '/e/');
  const origin = new URL(embedUrl).origin;
  const headers = { Referer: embedUrl };

  const res = await getWithFinalUrl(embedUrl, { headers });
  if (res.status === 404) throw new Error('Doodstream: Video nicht gefunden');
  if (isChallengePage(res.text, res.status)) {
    console.warn('[Doodstream] Cloudflare-Challenge – nutze Iframe-Fallback');
    return { streamType: 'embed', url: embedUrl, embedUrl, hosterName: 'Doodstream' };
  }
  const html = res.text || '';
  const pass = html.match(/\$\.get\('([^']*\/pass_md5\/[^']*)'/) || html.match(/(\/pass_md5\/[^'"]+)/);
  const token = html.match(/token=([a-zA-Z0-9]+)/);
  if (!pass || !token) {
    return { streamType: 'embed', url: embedUrl, embedUrl, hosterName: 'Doodstream' };
  }
  const passUrl = pass[1].startsWith('http') ? pass[1] : origin + pass[1];
  const base = (await getText(passUrl, { headers })).trim();
  if (!base) throw new Error('Doodstream: leere pass_md5-Antwort');
  const direct = `${base}${random(10)}?token=${token[1]}&expiry=${Date.now()}`;
  return {
    streamType: 'mp4',
    url: direct,
    embedUrl: res.url || embedUrl,
    referer: 'https://dood.li/',
    hosterName: 'Doodstream',
  };
}

module.exports = { name, aliases, matches, resolve };
