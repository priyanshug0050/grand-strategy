/**
 * ==========================================================================
 *  api.js — the only place that talks to the server
 * ==========================================================================
 *
 *  LOAD THIS BEFORE ANY PAGE SCRIPT. Every page does:
 *
 *      <script src="/js/api.js"></script>
 *      <script src="/js/dashboard.js"></script>
 *
 *  If a page script runs first, `API is not defined` — and that error looks
 *  like a missing file when it is really a load-order problem. Check the
 *  Network tab for a 200 vs 404 before assuming the file is gone.
 *
 *  The token lives in localStorage and goes out in an Authorization header,
 *  never a cookie. That means no CSRF surface: a cross-site form post cannot
 *  set a custom header.
 * ==========================================================================
 */

const API = (() => {
  'use strict';

  const TOKEN_KEY = 'gs_token';

  // Same-origin. The server serves this page AND the API, so there is no
  // cross-origin request and therefore no CORS to misconfigure.
  const BASE = '';

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }
  function isLoggedIn() { return !!getToken(); }

  /** Thrown for anything the server rejected. `.details` carries extra fields. */
  class ApiError extends Error {
    constructor(message, status, details) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.details = details || {};
    }
  }

  async function request(path, { method = 'GET', body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;

    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      // fetch only rejects on network failure, not on 4xx/5xx.
      throw new ApiError('Cannot reach the server. Is it running?', 0);
    }

    // An expired token should send the player to login rather than showing
    // a confusing error on every panel of the page.
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      clearToken();
      if (!location.pathname.endsWith('index.html') && location.pathname !== '/') {
        location.href = '/index.html';
      }
      throw new ApiError('Session expired. Sign in again.', 401);
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const { error, ...details } = data;
      throw new ApiError(error || `Request failed (${res.status})`, res.status, details);
    }
    return data;
  }

  return {
    ApiError,
    getToken, setToken, clearToken, isLoggedIn,

    register: (payload) => request('/api/auth/register', { method: 'POST', body: payload }),
    login:    (email, password) => request('/api/auth/login', { method: 'POST', body: { email, password } }),
    logout:   () => { clearToken(); location.href = '/index.html'; },

    nation:    () => request('/api/nation'),
    events:    (limit = 30) => request(`/api/nation/events?limit=${limit}`),
    reference: () => request('/api/reference'),
    health:    () => request('/api/health'),
    rankings:  () => request('/api/rankings'),

    buyInfrastructure: (cityId, target) =>
      request(`/api/city/${cityId}/infrastructure`, { method: 'POST', body: { target } }),
    previewCity: (cityId, infrastructure, land) =>
      request(`/api/city/${cityId}/preview`, { method: 'POST', body: { infrastructure, land } }),
    buyLand: (cityId, target) =>
      request(`/api/city/${cityId}/land`, { method: 'POST', body: { target } }),
    build: (cityId, improvement, count) =>
      request(`/api/city/${cityId}/improvements`, { method: 'POST', body: { improvement, count } }),
    foundCity: (name, continent) =>
      request('/api/city', { method: 'POST', body: { name, continent } }),

    recruit: (unit, count) => request('/api/military/recruit', { method: 'POST', body: { unit, count } }),
    wars: () => request('/api/wars'),
    targets: () => request('/api/targets'),
    previewAttack: (warId, attackType) =>
      request(`/api/war/${warId}/preview`, { method: 'POST', body: { attackType } }),
    declareWar: (targetId, warType) =>
      request('/api/war/declare', { method: 'POST', body: { targetId, warType } }),
    attack: (warId, attackType, target) =>
      request(`/api/war/${warId}/attack`, { method: 'POST', body: { attackType, target } }),

    buildProject: (project) => request('/api/project', { method: 'POST', body: { project } }),
    setPolicy: (type, policy) => request('/api/policy', { method: 'POST', body: { type, policy } }),
  };
})();

/* ---------- Formatting helpers, shared by every page ---------- */

const Fmt = {
  money: (n) => '$' + Math.round(n).toLocaleString(),
  int:   (n) => Math.round(n).toLocaleString(),
  dec:   (n, p = 2) => Number(n).toFixed(p),
  pct:   (n, p = 2) => Number(n).toFixed(p) + '%',
  signed: (n, p = 2) => (n >= 0 ? '+' : '') + Number(n).toFixed(p),

  /** "3h 12m" — used for the countdown to the next turn. */
  duration(ms) {
    if (ms <= 0) return 'now';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  },

  /** Turns improvement_key into "Improvement Key". */
  label: (key) => key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
};

/** Show a message in a container. Errors say what happened, not sorry. */
function showMessage(el, text, kind = 'error') {
  if (!el) return;
  el.className = `msg ${kind}`;
  el.textContent = text;
  el.classList.remove('hidden');
}

function clearMessage(el) {
  if (el) el.classList.add('hidden');
}

/** Redirect to login if there is no token. Call at the top of every page. */
function requireLogin() {
  if (!API.isLoggedIn()) { location.href = '/index.html'; return false; }
  return true;
}
