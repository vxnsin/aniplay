/**
 * Loader: Vidmoly
 * ───────────────
 * The embed page (vidmoly.biz/embed-<id>.html) carries a JWPlayer setup with
 *   sources: [{ file: 'https://…/master.m3u8?…' }]
 * Only a Referer of vidmoly.biz is required. Mirrors AniWorld-Downloader.
 */

const { getWithFinalUrl, isChallengePage } = require('../http');
const { unpackFromHtml } = require('./_unpack');

const name = 'vidmoly';
const aliases = ['vidmoly'];

function matches(url) {
  return /vidmoly\.(to|biz|net|me)/i.test(url);
}

function normalize(url) {
  const m = url.match(/vidmoly\.[a-z]+\/(?:w\/|embed-|d\/|)([a-z0-9]+)(?:\.html)?/i);
  const host = (url.match(/https?:\/\/([^/]+)/) || [])[1] || 'vidmoly.biz';
  return m ? `https://${host}/embed-${m[1]}.html` : url;
}

function extract(text) {
  const m =
    text.match(/sources\s*:\s*\[\s*\{[^}]*file\s*:\s*['"]([^'"]+?\.m3u8[^'"]*)['"]/) ||
    text.match(/file\s*:\s*['"]([^'"]+?\.m3u8[^'"]*)['"]/) ||
    text.match(/file\s*:\s*['"]([^'"]+?\.mp4[^'"]*)['"]/);
  return m ? m[1] : null;
}

async function resolve(url, ctx = {}) {
  const embedUrl = normalize(url);
  const res = await getWithFinalUrl(embedUrl, { headers: { Referer: 'https://vidmoly.biz/' } });
  if (res.status === 404) throw new Error('Vidmoly: Video nicht gefunden');
  if (isChallengePage(res.text, res.status)) throw new Error('Vidmoly: Cloudflare-Challenge');
  if (!res.ok) throw new Error(`Vidmoly: HTTP ${res.status}`);
  const html = res.text || '';
  if (/file was deleted|not found|wurde gelöscht/i.test(html.slice(0, 20000)) && !/\.m3u8/.test(html)) {
    throw new Error('Vidmoly: Datei wurde gelöscht');
  }

  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
  let src = extract(scripts) || extract(html);
  if (!src) {
    const unpacked = unpackFromHtml(html);
    if (unpacked) src = extract(unpacked);
  }
  if (!src) throw new Error('Vidmoly: keine Stream-URL gefunden');

  return {
    streamType: /\.m3u8/i.test(src) ? 'hls' : 'mp4',
    url: src,
    embedUrl: res.url || embedUrl,
    referer: 'https://vidmoly.biz/',
    hosterName: 'Vidmoly',
  };
}

module.exports = { name, aliases, matches, resolve };
