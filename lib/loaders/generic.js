/**
 * Loader: Generic (fallback for unknown hosters)
 * ──────────────────────────────────────────────
 *   1. unpack eval(p,a,c,k,e,d) if present
 *   2. look for sources:[{file:…}], file:"…", any .m3u8 / .mp4
 *   3. <video src> / <source src>
 *   4. first non-tracker <iframe src>  → embed
 *   5. embed the page itself
 */

const { getWithFinalUrl } = require('../http');
const { unpackFromHtml } = require('./_unpack');

const name = 'generic';

function matches() {
  return true;
}

function guessName(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const part = host.split('.')[0];
    return part.charAt(0).toUpperCase() + part.slice(1);
  } catch {
    return 'Unbekannt';
  }
}

function findMedia(text) {
  const tries = [
    /sources\s*:\s*\[\s*\{[^}]*['"]?file['"]?\s*:\s*['"]([^'"]+)['"]/,
    /['"]?file['"]?\s*:\s*['"]((?:https?:)?\/\/[^'"]+\.(?:m3u8|mp4)[^'"]*)['"]/,
    /(https?:\/\/[^\s"'\\<>]+\.m3u8[^\s"'\\<>]*)/,
    /(https?:\/\/[^\s"'\\<>]+\.mp4[^\s"'\\<>]*)/,
    /<video[^>]+src=["']([^"']+)["']/i,
    /<source[^>]+src=["']([^"']+)["']/i,
  ];
  for (const re of tries) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

async function resolve(url, ctx = {}) {
  const hosterName = ctx.hosterName || guessName(url);
  let res;
  try {
    res = await getWithFinalUrl(url, { headers: { Referer: ctx.referer || 'https://aniworld.to/' } });
  } catch {
    return { streamType: 'embed', url, embedUrl: url, hosterName };
  }
  const finalUrl = res.url || url;
  const html = res.ok ? res.text || '' : '';

  const unpacked = unpackFromHtml(html);
  let src = (unpacked && findMedia(unpacked)) || findMedia(html);
  if (src) {
    if (src.startsWith('//')) src = 'https:' + src;
    else if (!/^https?:/.test(src)) src = new URL(src, finalUrl).href;
    return {
      streamType: /\.m3u8/i.test(src) ? 'hls' : 'mp4',
      url: src,
      embedUrl: finalUrl,
      referer: new URL(finalUrl).origin + '/',
      hosterName,
    };
  }

  for (const tag of html.match(/<iframe[^>]+src=["'][^"']+["'][^>]*>/gi) || []) {
    const s = (tag.match(/src=["']([^"']+)["']/i) || [])[1];
    if (!s || /google|facebook|twitter|analytics|ads|recaptcha|challenges\.cloudflare/i.test(s)) continue;
    const iframeSrc = /^https?:/.test(s) ? s : new URL(s, finalUrl).href;
    return { streamType: 'embed', url: iframeSrc, embedUrl: iframeSrc, hosterName };
  }

  return { streamType: 'embed', url: finalUrl, embedUrl: finalUrl, hosterName };
}

module.exports = { name, matches, resolve };
