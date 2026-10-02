/**
 * lib/http.js
 * ───────────
 * Small fetch wrapper around Node's native fetch (undici):
 *   - one shared desktop User-Agent (hosters like Doodstream bind the stream to it)
 *   - request timeout via AbortController
 *   - helpers that return text / json / the final URL after redirects
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BASE_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
};

class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} bei ${url}`);
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/**
 * fetch() with a timeout and default headers.
 * @param {string} url
 * @param {RequestInit & { timeout?: number }} [opts]
 */
async function request(url, opts = {}) {
  const { timeout = 15000, headers = {}, signal, ...rest } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timeout nach ${timeout}ms: ${url}`)), timeout);
  if (signal) signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  try {
    return await fetch(url, {
      redirect: 'follow',
      ...rest,
      headers: { ...BASE_HEADERS, ...headers },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** GET → response text. Throws HttpError on non-2xx. */
async function getText(url, opts = {}) {
  const res = await request(url, opts);
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, url, text.slice(0, 500));
  return text;
}

/** GET → parsed JSON. Throws HttpError on non-2xx. */
async function getJson(url, opts = {}) {
  const res = await request(url, { ...opts, headers: { Accept: 'application/json, */*;q=0.5', ...(opts.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, url, text.slice(0, 500));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Ungültiges JSON von ${url}`);
  }
}

/** GET with redirects → { url: finalUrl, status, text } */
async function getWithFinalUrl(url, opts = {}) {
  const res = await request(url, opts);
  const text = await res.text();
  return { url: res.url || url, status: res.status, ok: res.ok, text };
}

/** Does this HTML look like a Cloudflare / captcha interstitial? */
function isChallengePage(html, status) {
  if (status === 403 || status === 429 || status === 503) return true;
  const head = (html || '').slice(0, 6000).toLowerCase();
  return /just a moment|cf-challenge|challenge-platform|turnstile|attention required|verifizierung/.test(head);
}

module.exports = { UA, BASE_HEADERS, HttpError, request, getText, getJson, getWithFinalUrl, isChallengePage };
