/**
 * Loader: Streamtape
 * ──────────────────
 * The page builds the link in two halves:
 *   document.getElementById('robotlink').innerHTML = '//streamtape.com/get_video?id=…' + ('xcd…').substring(3)
 */

const { getWithFinalUrl, isChallengePage } = require('../http');

const name = 'streamtape';
const aliases = ['streamtape', 'strtape', 'stape'];

function matches(url) {
  return /streamtape\.(com|net|to|xyz|site)|strtape|stape\.fun|streamta\.pe|tapecontent/i.test(url);
}

async function resolve(url, ctx = {}) {
  const embedUrl = url.replace('/v/', '/e/').replace('/d/', '/e/');
  const res = await getWithFinalUrl(embedUrl, { headers: { Referer: ctx.referer || 'https://aniworld.to/' } });
  if (res.status === 404) throw new Error('Streamtape: Video nicht gefunden');
  if (isChallengePage(res.text, res.status)) throw new Error('Streamtape: Cloudflare-Challenge');
  const html = res.text || '';

  const m = html.match(/getElementById\(['"](?:robotlink|ideoooolink|norobotlink)['"]\)\.innerHTML\s*=\s*(['"])(.*?)\1\s*\+\s*\((['"])(.*?)\3\)\.substring\((\d+)\)/);
  if (!m) throw new Error('Streamtape: keine Stream-URL gefunden');
  let link = m[2] + m[4].substring(parseInt(m[5], 10));
  if (link.startsWith('//')) link = 'https:' + link;
  if (!/[?&]stream=1/.test(link)) link += '&stream=1';
  return {
    streamType: 'mp4',
    url: link,
    embedUrl: res.url || embedUrl,
    referer: new URL(res.url || embedUrl).origin + '/',
    hosterName: 'Streamtape',
  };
}

module.exports = { name, aliases, matches, resolve };
