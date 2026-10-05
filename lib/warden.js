/**
 * Optional port from warden (https://github.com/vxnsin/warden).
 *
 * When a warden runs on this machine the server asks it for its port instead
 * of taking PORT as it is: the same name gets the same port on every start,
 * and warden knows who holds it. Without a warden nothing changes. Started
 * through `warden run`, the port is already in PORT and the lease is the
 * wrapper's to keep.
 *
 *   WARDEN=0        never ask
 *   WARDEN_URL      where the warden is (default http://127.0.0.1:7010)
 *   WARDEN_TOKEN    bearer token, when the warden wants one
 *   WARDEN_NAME     name to register under (default: the package name)
 *   PORT            the preferred port; warden hands it out when it is free
 */

const DEFAULT_URL = 'http://127.0.0.1:7010';
const TTL = 90; // seconds a lease lasts without a heartbeat
const TIMEOUT = 1500; // ms before a warden counts as absent

function off(env) {
  return /^(0|false|off|no)$/i.test(env.WARDEN || '');
}

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 64) || 'app';
}

function settings(env, name) {
  return {
    url: (env.WARDEN_URL || DEFAULT_URL).replace(/\/$/, ''),
    asked: !!env.WARDEN_URL,
    token: env.WARDEN_TOKEN || '',
    name: slug(env.WARDEN_NAME || name),
  };
}

class WardenError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function call(cfg, method, path, body) {
  const headers = {};
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(cfg.url + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT) });
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) {
    const detail = data && typeof data.detail === 'string' ? data.detail : text || `HTTP ${res.status}`;
    throw new WardenError(detail, res.status);
  }
  return data;
}

async function reachable(cfg) {
  try {
    const health = await call(cfg, 'GET', '/health');
    return !!(health && health.status && health.version);
  } catch {
    return false;
  }
}

/**
 * The port to listen on: from warden when there is one, otherwise `fallback`.
 * Resolves to { port, warden } where warden is null or { name, url }.
 * Never throws; a warden that refuses is reported and the fallback is used.
 */
async function claimPort({ name, kind = 'web', preferred, fallback, meta = {}, env = process.env, log = console.log }) {
  if (off(env)) return { port: fallback, warden: null };

  if (env.WARDEN_SERVICE && env.WARDEN_PORT) {
    const port = parseInt(env.WARDEN_PORT, 10);
    if (port) return { port, warden: { name: env.WARDEN_SERVICE, url: null, wrapped: true } };
  }

  const cfg = settings(env, name);
  if (!(await reachable(cfg))) {
    if (cfg.asked) log(`  warden unter ${cfg.url} nicht erreichbar, nehme Port ${fallback}`);
    return { port: fallback, warden: null };
  }

  let reg;
  try {
    reg = await call(cfg, 'POST', '/v1/services', {
      name: cfg.name, kind, host: '127.0.0.1', preferred_port: preferred || null, pid: process.pid, ttl: TTL, meta,
    });
  } catch (e) {
    log(`  warden (${cfg.url}) gibt keinen Port: ${e.message}, nehme Port ${fallback}`);
    return { port: fallback, warden: null };
  }

  keep(cfg, reg);
  return { port: reg.port, warden: { name: reg.name, url: cfg.url, wrapped: false } };
}

/** Renew the lease while running, give the port back on the way out. */
function keep(cfg, reg) {
  const beat = () => call(cfg, 'POST', `/v1/services/${reg.name}/heartbeat`, { pid: process.pid, ttl: TTL }).catch(() => {});
  const timer = setInterval(beat, (TTL / 3) * 1000);
  timer.unref();

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    try { await call(cfg, 'DELETE', `/v1/services/${reg.name}`); } catch { /* the lease lapses on its own */ }
  };
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, () => release().finally(() => process.exit(code)));
  }
}

/** The port a service holds at the warden, or null. For tools that only want to find the server. */
async function lookupPort({ name, env = process.env }) {
  if (off(env)) return null;
  const cfg = settings(env, name);
  try {
    const reg = await call(cfg, 'GET', `/v1/services/${cfg.name}`);
    return reg && reg.port ? reg.port : null;
  } catch {
    return null;
  }
}

module.exports = { claimPort, lookupPort, DEFAULT_URL };
