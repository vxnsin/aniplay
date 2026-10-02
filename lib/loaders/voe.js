/**
 * Loader: VOE
 * ───────────
 * voe.sx/e/<id> answers with a tiny "Redirecting..." page that points to the
 * real (rotating) player domain. That page embeds the player config as an
 * obfuscated string inside <script type="application/json">. Decoding:
 *   ROT13 → strip junk tokens → base64 → shift every char code by -3
 *   → reverse → base64 → JSON  (→ .source = master.m3u8, .direct_access_url = mp4)
 * Mirrors phoenixthrush/AniWorld-Downloader (extractors/provider/voe.py).
 */

const { getWithFinalUrl, isChallengePage } = require('../http');

const name = 'voe';
const aliases = ['voe.sx', 'voe'];

const JUNK = ['@$', '^^', '~@', '%?', '*~', '!!', '#&'];
const M3U8_RE = /https?:\/\/[^\s'"<>]+?\.m3u8[^\s'"<>]*/;

function matches(url) {
  return /voe\.sx|voe-un-?block|\/e\/[a-z0-9]{10,14}(?:$|\?)/i.test(url) && !/vidmoly|filemoon|dood/i.test(url);
}

function rot13(s) {
  return s.replace(/[a-zA-Z]/g, (c) => {
    const b = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
  });
}

function decodeVoe(encoded) {
  let s = rot13(encoded);
  for (const j of JUNK) s = s.split(j).join('_');
  s = s.replace(/_/g, '');
  s = Buffer.from(s, 'base64').toString('latin1');
  s = Array.from(s, (c) => String.fromCharCode(c.charCodeAt(0) - 3)).join('');
  s = Buffer.from(Array.from(s).reverse().join(''), 'base64').toString('utf8');
  return JSON.parse(s);
}

function extractConfig(html) {
  // Variant 1: <script type="application/json">["<encoded>"]</script>
  for (const m of html.matchAll(/<script\s+type=["']application\/json["']>([\s\S]*?)<\/script>/g)) {
    let raw = m[1].trim();
    try {
      let parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) parsed = parsed[0];
      if (typeof parsed === 'string') return decodeVoe(parsed);
    } catch {
      /* try the raw string */
    }
    try {
      if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
      return decodeVoe(raw);
    } catch {
      /* next block */
    }
  }
  // Variant 2: var a168c='<encoded>'
  const m2 = html.match(/var\s+a168c\s*=\s*'([^']+)'/);
  if (m2) {
    try { return decodeVoe(m2[1]); } catch { /* fall through */ }
  }
  // Variant 3: plain 'hls': '<url>'
  const m3 = html.match(/['"]hls['"]\s*:\s*['"]([^'"]+)['"]/);
  if (m3) return { source: m3[1] };
  // Variant 4: a bare m3u8 anywhere
  const m4 = html.match(M3U8_RE);
  if (m4) return { source: m4[0] };
  return null;
}

async function resolve(url, ctx = {}) {
  let current = url;
  let html = '';
  let finalUrl = url;

  // follow the JS redirect chain (voe.sx → rotating player domain), max 3 hops
  for (let hop = 0; hop < 3; hop++) {
    const res = await getWithFinalUrl(current, {
      headers: { Referer: ctx.referer || 'https://aniworld.to/', 'Accept-Language': 'en-US,en;q=0.5' },
    });
    if (res.status === 404 || res.status === 410) throw new Error('VOE: Video nicht (mehr) verfügbar');
    if (isChallengePage(res.text, res.status)) throw new Error('VOE: Cloudflare-Challenge');
    html = res.text;
    finalUrl = res.url;
    const cfg = extractConfig(html);
    if (cfg) return build(cfg, finalUrl);
    const next =
      html.match(/window\.location\.href\s*=\s*['"](https?:\/\/[^'"]+\/e\/[^'"]+)['"]/) ||
      html.match(/['"](https?:\/\/[^'"<>\s]+\/e\/[^'"<>\s]+)['"]/);
    if (!next || next[1] === current) break;
    current = next[1];
  }
  throw new Error('VOE: keine Stream-Quelle in der Seite gefunden');
}

function build(cfg, embedUrl) {
  const hls = cfg.source && /\.m3u8/i.test(cfg.source) ? cfg.source : null;
  const mp4 = cfg.direct_access_url || (cfg.source && /\.mp4/i.test(cfg.source) ? cfg.source : null) || cfg.fallback || null;
  if (!hls && !mp4) throw new Error('VOE: Config ohne Quelle');
  const origin = new URL(embedUrl).origin + '/';
  return {
    streamType: hls ? 'hls' : 'mp4',
    url: hls || mp4,
    altUrl: hls && mp4 ? mp4 : null,
    altType: hls && mp4 ? 'mp4' : null,
    embedUrl,
    referer: origin,
    hosterName: 'VOE',
    title: cfg.title || null,
  };
}

module.exports = { name, aliases, matches, resolve, decodeVoe };
