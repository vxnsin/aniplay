/**
 * Loader: Vidoza / videzz.net
 * ───────────────────────────
 * Page contains  sourcesCode: [{ src: "https://…mp4", … }]
 */

const { getWithFinalUrl, isChallengePage } = require('../http');

const name = 'vidoza';
const aliases = ['vidoza', 'videzz'];

function matches(url) {
  return /vidoza\.(net|co|org)|videzz\.net/i.test(url);
}

async function resolve(url, ctx = {}) {
  const res = await getWithFinalUrl(url, { headers: { Referer: ctx.referer || 'https://aniworld.to/' } });
  if (res.status === 404) throw new Error('Vidoza: Video nicht gefunden');
  if (isChallengePage(res.text, res.status)) throw new Error('Vidoza: Cloudflare-Challenge');
  const html = res.text || '';
  const m = html.match(/sourcesCode\s*:\s*\[[\s\S]*?src\s*:\s*["']([^"']+)["']/) || html.match(/src\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/);
  if (!m) throw new Error('Vidoza: keine Stream-URL gefunden');
  return {
    streamType: /\.m3u8/i.test(m[1]) ? 'hls' : 'mp4',
    url: m[1],
    embedUrl: res.url || url,
    referer: new URL(res.url || url).origin + '/',
    hosterName: 'Vidoza',
  };
}

module.exports = { name, aliases, matches, resolve };
