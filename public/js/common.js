/* shared helpers: theme toggle, toast, formatting, api, websocket with reconnect */
(function () {
  const root = document.documentElement;

  // ── theme (saved choice wins, otherwise the system setting; TV defaults to dark) ──
  const KEY = 'aniplay:theme';
  function currentTheme() {
    const attr = root.getAttribute('data-theme');
    if (attr === 'dark' || attr === 'light') return attr;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function applySavedTheme(defaultTheme) {
    let saved = null;
    try { saved = localStorage.getItem(KEY); } catch {}
    if (saved === 'dark' || saved === 'light') root.setAttribute('data-theme', saved);
    else if (defaultTheme) root.setAttribute('data-theme', defaultTheme);
  }
  function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem(KEY, next); } catch {}
    updateThemeButtons();
  }
  function updateThemeButtons() {
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
      b.textContent = currentTheme() === 'dark' ? '☾ night' : '☼ day';
    });
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme-toggle]');
    if (b) toggleTheme();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateThemeButtons);

  // ── icons: one inline SVG sprite, used as <svg class="ico"><use href="#i-play"/></svg>
  // (real vector icons instead of emoji glyphs, which TVs and phones render as colourful emoji)
  const ICONS = {
    play: '<path d="M4 2l10 6-10 6z"/>',
    pause: '<path d="M3 2h4v12H3zM9 2h4v12H9z"/>',
    stop: '<path d="M3 3h10v10H3z"/>',
    prev: '<path d="M2 2h2v12H2zM14 2L5 8l9 6z"/>',
    next: '<path d="M12 2h2v12h-2zM2 2l9 6-9 6z"/>',
    rew: '<path d="M8 2L1 8l7 6zM15 2L8 8l7 6z"/>',
    fwd: '<path d="M8 2l7 6-7 6zM1 2l7 6-7 6z"/>',
    back10: '<path d="M8 2L1 8l7 6V9h2V7H8z"/><path d="M11 7h4v2h-4z"/>',
    fwd10: '<path d="M8 2l7 6-7 6V9H6V7h2z"/><path d="M1 7h4v2H1z"/>',
    volume: '<path d="M2 6h3l4-4v12l-4-4H2z"/><path d="M11 5v6h1V5zM13 3v10h1V3z"/>',
    volumeLow: '<path d="M2 6h3l4-4v12l-4-4H2z"/><path d="M11 6v4h1V6z"/>',
    mute: '<path d="M2 6h3l4-4v12l-4-4H2z"/><path d="M10.6 5.2l1.4 1.4 1.4-1.4L14.8 6.6 13.4 8l1.4 1.4-1.4 1.4L12 9.4l-1.4 1.4-1.4-1.4L10.6 8 9.2 6.6z"/>',
    fullscreen: '<path d="M2 2h5v2H4v3H2zM9 2h5v5h-2V4H9zM2 9h2v3h3v2H2zM12 9h2v5H9v-2h3z"/>',
    sync: '<path d="M8 2a6 6 0 0 1 5.2 3H15v4h-4V7h1.6A4 4 0 0 0 4 8H2a6 6 0 0 1 6-6zM8 14a6 6 0 0 1-5.2-3H1V7h4v2H3.4A4 4 0 0 0 12 8h2a6 6 0 0 1-6 6z"/>',
    restart: '<path d="M8 2a6 6 0 1 1-6 6h2a4 4 0 1 0 4-4v2L4 3l4-3z"/>',
    tv: '<path d="M1 2h14v9H1zM3 4v5h10V4zM5 12h6v2H5z"/>',
    phone: '<path d="M4 1h8v14H4zM6 3v9h4V3zM7 13h2v1H7z"/>',
    chev: '<path d="M5 2l6 6-6 6-1.4-1.4L8.2 8 3.6 3.4z"/>',
    warn: '<path d="M8 1l7 13H1zM7 6v4h2V6zM7 11v2h2v-2z"/>',
  };
  function iconSprite() {
    if (document.getElementById('ap-sprite')) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'ap-sprite';
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    svg.innerHTML = Object.entries(ICONS).map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 16 16" fill="currentColor" shape-rendering="crispEdges">${v}</symbol>`).join('');
    document.body.prepend(svg);
    // <i data-ico="play"></i> shorthand in markup → inline svg
    document.querySelectorAll('[data-ico]').forEach((el) => { el.outerHTML = icon(el.dataset.ico, el.className); });
  }
  const icon = (name, cls = '') => `<svg class="ico ${cls}"><use href="#i-${name}"></use></svg>`;
  /** swap the symbol an existing <svg class="ico"> shows */
  function setIcon(el, name) {
    const use = el && (el.tagName === 'use' ? el : el.querySelector('use'));
    if (use) use.setAttribute('href', `#i-${name}`);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iconSprite);
  else iconSprite();

  // ── toast ──
  let toastEl, toastTimer;
  function toast(msg, ms = 2600) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  // ── formatting ──
  function fmtTime(s) {
    if (!Number.isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(sec).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }
  function epLabel(ep) {
    if (!ep) return '';
    return ep.seasonNum === 0 ? `Film ${ep.num}` : `S${ep.seasonNum}E${String(ep.num).padStart(2, '0')}`;
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  const LANG_SHORT = { 1: 'DE', 2: 'EN-SUB', 3: 'DE-SUB', 4: 'EN' };
  const LANG_LABEL = { 1: 'Deutsch', 2: 'Eng Sub', 3: 'Ger Sub', 4: 'English' };

  // ── api ──
  // the tv session this page belongs to; every request and the websocket carry it
  let tvCode = null;
  const setTv = (code) => { tvCode = code ? String(code).toUpperCase() : null; };
  const getTv = () => tvCode;

  async function api(path, body, method) {
    const res = await fetch(path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(tvCode ? { 'X-TV': tvCode } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok || (data && data.error)) throw Object.assign(new Error((data && data.error) || `HTTP ${res.status}`), { code: data && data.code, status: res.status });
    return data;
  }
  // browsers word network failures as "Load failed" (Safari) or "Failed to fetch" (Chrome); say what it means
  const _api = api;
  async function apiFriendly(path, body, method) {
    try {
      return await _api(path, body, method);
    } catch (e) {
      if (e instanceof TypeError || /load failed|failed to fetch|networkerror/i.test(e.message)) {
        throw new Error('server nicht erreichbar – läuft er noch? ich verbinde neu …');
      }
      throw e;
    }
  }

  // ── websocket with auto-reconnect ──
  function connectWs(role, handlers) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws, retry = 1000, closedByUs = false;
    const state = { send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }, get open() { return !!ws && ws.readyState === WebSocket.OPEN; } };
    function open() {
      ws = new WebSocket(`${proto}://${location.host}/?role=${role}&s=${encodeURIComponent(tvCode || '')}`);
      ws.onopen = () => { retry = 1000; handlers.onOpen && handlers.onOpen(); };
      ws.onclose = (e) => {
        // 4004: this tv code does not exist (any more) – no point in reconnecting
        if (e.code === 4004) { closedByUs = true; handlers.onNoTv && handlers.onNoTv(); return; }
        handlers.onClose && handlers.onClose();
        if (!closedByUs) setTimeout(open, retry), (retry = Math.min(retry * 1.5, 8000));
      };
      ws.onerror = () => {};
      ws.onmessage = (e) => { try { handlers.onMessage(JSON.parse(e.data)); } catch (err) { console.warn('ws message', err); } };
    }
    open();
    state.close = () => { closedByUs = true; ws && ws.close(); };
    return state;
  }

  window.AP = { setTv, getTv, applySavedTheme, toggleTheme, updateThemeButtons, toast, fmtTime, epLabel, esc, api: apiFriendly, connectWs, icon, setIcon, LANG_SHORT, LANG_LABEL };
})();
