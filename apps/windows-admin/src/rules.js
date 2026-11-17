/** Which addresses the desktop shell opens. Kept free of Electron so plain Node can test it. */

export const DEFAULT_ORIGIN = 'https://kunlun.idalee.cn';
export const AREA = '/admin';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Returns the bare origin of a server address, or throws when the shell must not use it. */
export function parseOrigin(value, { allowLoopbackHttp = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`服务地址无效：${value}`); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`服务地址只写协议和域名，例如 ${DEFAULT_ORIGIN}`);
  }
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && allowLoopbackHttp && LOOPBACK.has(url.hostname)) return url.origin;
  throw new Error('服务地址必须是 https://，只有本机调试可以用 http://127.0.0.1');
}

/**
 * The server this copy talks to. An installed copy only uses the address baked in at packaging time;
 * the KUNLUN_DESKTOP_ORIGIN override (which may be a local http server) works only when run from source.
 */
export function resolveOrigin({ packaged, configured, override }) {
  if (!packaged && override) return parseOrigin(override, { allowLoopbackHttp: true });
  return parseOrigin(configured || DEFAULT_ORIGIN);
}

export const startUrl = origin => origin + AREA;

/** True for pages of the admin area on the configured server; `/` is allowed because it redirects there. */
export function isAppUrl(origin, value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.origin !== origin) return false;
  return url.pathname === '/' || url.pathname === AREA || url.pathname.startsWith(AREA + '/');
}

/** Links that leave the admin area open in the system browser, but only plain https pages. */
export function externalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** A login the page asked to remember, trimmed to what the login form accepts; anything else is null. */
export function normalizeLogin(value) {
  if (!value || typeof value !== 'object') return null;
  const username = typeof value.username === 'string' ? value.username.trim() : '';
  const password = typeof value.password === 'string' ? value.password : '';
  if (!username || username.length > 32 || !password || password.length > 128) return null;
  return { username, password };
}

/** The saved login for this server, or null when it was saved for another one or is unreadable. */
export function savedLoginFor(origin, value) {
  if (!value || typeof value !== 'object' || value.origin !== origin) return null;
  return normalizeLogin(value);
}

export const ZOOM_LEVELS = { min: -3, max: 5, step: 0.5 };

/** A saved zoom level, kept within bounds; anything unreadable is the normal size. */
export function clampZoom(level) {
  const value = Number(level);
  return Number.isFinite(value) ? Math.min(ZOOM_LEVELS.max, Math.max(ZOOM_LEVELS.min, value)) : 0;
}

export function nextZoom(level, direction) {
  if (direction === 'reset') return 0;
  return clampZoom(level + (direction === 'in' ? ZOOM_LEVELS.step : -ZOOM_LEVELS.step));
}
