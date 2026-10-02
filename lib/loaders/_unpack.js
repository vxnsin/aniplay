/**
 * Dean Edwards "p,a,c,k,e,d" JavaScript unpacker (shared by several loaders).
 * Not a loader itself – the registry ignores it because it has no matches()/resolve().
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function decodeBaseN(token, radix) {
  let result = 0;
  for (const ch of token) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0 || digit >= radix) return -1;
    result = result * radix + digit;
  }
  return result;
}

function unpackJs(packed, radix, keywords) {
  return packed.replace(/\b(\w+)\b/g, (tok) => {
    const idx = decodeBaseN(tok, radix);
    return idx >= 0 && idx < keywords.length && keywords[idx] ? keywords[idx] : tok;
  });
}

/** Find and unpack the first eval(function(p,a,c,k,e,d)…) block in html, or null. */
function unpackFromHtml(html) {
  const m = html.match(/eval\(function\(p,a,c,k,e,d\)\{.*?\}\('((?:\\.|[^'\\])*)',\s*(\d+),\s*(\d+),\s*'((?:\\.|[^'\\])*)'\.split\('\|'\)/s);
  if (!m) return null;
  return unpackJs(m[1].replace(/\\'/g, "'"), parseInt(m[2], 10), m[4].split('|'));
}

module.exports = { unpackJs, unpackFromHtml };
