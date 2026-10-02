/**
 * Loader: Filemoon (incl. the newer "Byse" frontend on rotating domains)
 * ────────────────────────────────────────────────────────────────────────
 * 1. REST API  GET {origin}/api/videos/{code}  → playback.{iv,payload,key_parts}
 *    AES-256-GCM, key = concat of the base64url-decoded key_parts.
 * 2. Legacy page with Dean-Edwards packed JS  → sources:[{file:"…m3u8"}]
 * 3. Fallback: embed the /e/{code} player in an iframe.
 * Mirrors phoenixthrush/AniWorld-Downloader (extractors/provider/filemoon.py).
 */

const { webcrypto } = require('node:crypto');
const { getJson, getWithFinalUrl } = require('../http');
const { unpackJs } = require('./_unpack');

const name = 'filemoon';
const aliases = ['filemoon', 'byse'];

function matches(url) {
  return /filemoon\.(sx|to|in|nl|wf|eu|art)|bysezejataos\.com|byse/i.test(url);
}

function b64url(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

async function aesGcm(keyBytes, ivB64, payloadB64) {
  const key = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const pt = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: b64url(ivB64) }, key, b64url(payloadB64));
  return JSON.parse(Buffer.from(pt).toString('utf8'));
}

async function decryptPlayback(pb) {
  const parts = Array.isArray(pb.key_parts) ? pb.key_parts.filter(Boolean).map(b64url) : [];
  if (!parts.length) return null;
  const candidates = [
    Buffer.concat(parts.filter((p) => p.length === 16)),
    Buffer.concat(parts),
    Buffer.concat(parts.slice().reverse()),
  ].filter((k) => k.length === 16 || k.length === 24 || k.length === 32);
  for (const key of candidates) {
    for (const [iv, payload] of [['iv', 'payload'], ['iv2', 'payload2']]) {
      if (!pb[iv] || !pb[payload]) continue;
      try { return await aesGcm(key, pb[iv], pb[payload]); } catch { /* next */ }
    }
  }
  return null;
}

function bestSource(data) {
  if (Array.isArray(data.sources) && data.sources.length) {
    const sorted = data.sources.filter((s) => s && (s.url || s.file)).sort((a, b) => (b.height || 0) - (a.height || 0));
    if (sorted[0]) return sorted[0].url || sorted[0].file;
  }
  return data.source || data.file || null;
}

function fromText(text) {
  const hls = text.match(/['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/);
  if (hls) return hls[1];
  const src = text.match(/sources\s*:\s*\[\s*\{[^}]*file\s*:\s*['"]([^'"]+)['"]/);
  if (src) return src[1];
  const file = text.match(/file\s*:\s*['"](https?:\/\/[^'"]+)['"]/);
  if (file && /\.(m3u8|mp4)/i.test(file[1])) return file[1];
  return null;
}

async function resolve(url, ctx = {}) {
  const m = url.match(/\/(?:[de]|embed-)\/?([a-zA-Z0-9]+)/) || url.match(/embed-([a-zA-Z0-9]+)/);
  const code = m ? m[1].replace(/\.html$/, '') : null;
  const origin = new URL(url).origin;
  const embedUrl = code ? `${origin}/e/${code}` : url;
  const headers = { Referer: embedUrl, Origin: origin };

  // 1. API
  if (code) {
    try {
      const data = await getJson(`${origin}/api/videos/${code}`, { headers });
      if (data && data.playback) {
        const dec = await decryptPlayback(data.playback);
        const src = dec && bestSource(dec);
        if (src) return out(src, embedUrl, origin);
        console.warn('[Filemoon] API ok, aber Entschlüsselung fehlgeschlagen – versuche Seite');
      }
    } catch (e) {
      console.warn(`[Filemoon] API: ${e.message}`);
    }
  }

  // 2. legacy HTML
  const page = await getWithFinalUrl(embedUrl, { headers: { Referer: ctx.referer || 'https://aniworld.to/' } });
  if (page.status === 404) throw new Error('Filemoon: Video nicht gefunden');
  const html = page.text || '';
  const packed = html.match(/eval\(function\(p,a,c,k,e,d\)\{.*?\}\('((?:\\.|[^'\\])*)',\s*(\d+),\s*(\d+),\s*'((?:\\.|[^'\\])*)'\.split\('\|'\)/s);
  if (packed) {
    const unpacked = unpackJs(packed[1].replace(/\\'/g, "'"), parseInt(packed[2], 10), packed[4].split('|'));
    const src = fromText(unpacked);
    if (src) return out(src, embedUrl, origin);
  }
  const direct = fromText(html);
  if (direct) return out(direct, embedUrl, origin);

  // 3. iframe fallback
  return { streamType: 'embed', url: embedUrl, embedUrl, hosterName: 'Filemoon' };
}

function out(src, embedUrl, origin) {
  return {
    streamType: /\.m3u8/i.test(src) ? 'hls' : 'mp4',
    url: src,
    embedUrl,
    referer: origin + '/',
    hosterName: 'Filemoon',
  };
}

module.exports = { name, aliases, matches, resolve };
