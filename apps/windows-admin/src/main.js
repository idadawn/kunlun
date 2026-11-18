/**
 * Windows desktop shell for the admin site: one window showing the live /admin pages of the server
 * baked in at packaging time. Pages come from the server, so publishing the site updates every desk.
 */
import { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, screen, session, shell } from 'electron';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authPause, clampZoom, externalUrl, isAppUrl, loginOffer, nextZoom, normalizeLogin, resolveOrigin, savedLoginFor, startUrl,
} from './rules.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
const OFFLINE_PAGE = join(here, 'offline.html');
const PRELOAD = join(here, 'preload.cjs');
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);

const statePath = () => join(app.getPath('userData'), 'window-state.json');
// Encrypted with Windows DPAPI through safeStorage, so only this Windows user on this computer can read it.
const loginPath = () => join(app.getPath('userData'), 'saved-login.bin');

const encryptionAvailable = () => safeStorage.isAsyncEncryptionAvailable().catch(() => false);

async function writeSavedLogin(origin, login) {
  writeFileSync(loginPath(), await safeStorage.encryptStringAsync(JSON.stringify({ origin, ...login })));
}

async function readSavedLogin(origin) {
  let encrypted;
  try { encrypted = readFileSync(loginPath()); } catch { return null; }
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(encrypted);
    const login = savedLoginFor(origin, JSON.parse(result));
    if (login && shouldReEncrypt) await writeSavedLogin(origin, login).catch(() => {});
    return login;
  } catch {
    return null;
  }
}

const forgetSavedLogin = () => rmSync(loginPath(), { force: true });

// Whether 自动登录 is ticked: on unless the user unticked it. Not secret, so kept in plain JSON.
const loginSettingsPath = () => join(app.getPath('userData'), 'login-settings.json');
function readRemember() {
  try { return JSON.parse(readFileSync(loginSettingsPath(), 'utf8')).remember !== false; } catch { return true; }
}
function writeRemember(remember) {
  try { writeFileSync(loginSettingsPath(), JSON.stringify({ remember })); } catch { /* The box falls back to ticked. */ }
}

/** The 自动登录 box on the login page talks to these; only the admin pages of the configured server get answers. */
function setupSavedLogin(win, origin) {
  // A logout or password change stops the next automatic login until a login works again (or the app restarts).
  let pause = null;
  win.webContents.session.webRequest.onSendHeaders({ urls: ['*://*/api/auth/*'] }, details => {
    pause = authPause(origin, details.method, details.url) ?? pause;
  });
  const fromAdminPage = event => event.sender === win.webContents && event.senderFrame?.parent === null
    && isAppUrl(origin, event.senderFrame.url);

  ipcMain.handle('kunlun:login:get', async event => {
    if (!fromAdminPage(event)) return null;
    const available = await encryptionAvailable();
    return loginOffer({ available, saved: available ? await readSavedLogin(origin) : null, remember: readRemember(), pause });
  });
  ipcMain.handle('kunlun:login:succeeded', async (event, value) => {
    if (!fromAdminPage(event)) return false;
    pause = null;
    const remember = value?.remember === true;
    const login = normalizeLogin(value);
    writeRemember(remember);
    if (!remember || !login || !await encryptionAvailable()) { forgetSavedLogin(); return false; }
    await writeSavedLogin(origin, login);
    return true;
  });
  ipcMain.handle('kunlun:login:forget', event => {
    if (!fromAdminPage(event)) return false;
    writeRemember(false);
    forgetSavedLogin();
    return true;
  });
}

function readState() {
  try {
    const saved = JSON.parse(readFileSync(statePath(), 'utf8'));
    return { maximized: saved.maximized !== false, zoomLevel: clampZoom(saved.zoomLevel) };
  } catch {
    return { maximized: true, zoomLevel: 0 };
  }
}

function writeState(state) {
  try { writeFileSync(statePath(), JSON.stringify(state)); } catch { /* Only window size and zoom are lost. */ }
}

function openOutside(url) {
  const target = externalUrl(url);
  if (target) shell.openExternal(target);
}

function setupSession(origin) {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(permission === 'notifications' ? details.isMainFrame && isAppUrl(origin, details.requestingUrl) : ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    if (permission !== 'notifications') return ALLOWED_PERMISSIONS.has(permission);
    // Chromium also checks the notification origin without an associated document.
    return isAppUrl(origin, requestingOrigin) && (!details.requestingUrl || (details.isMainFrame && isAppUrl(origin, details.requestingUrl)));
  });
  // Exports and the price poster are blob downloads; ask where to save, starting in the Downloads folder.
  ses.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ title: '保存文件', defaultPath: join(app.getPath('downloads'), item.getFilename()) });
  });
}

function createWindow(origin) {
  const state = readState();
  const area = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1440, area.width),
    height: Math.min(900, area.height),
    minWidth: Math.min(1024, area.width),
    minHeight: Math.min(640, area.height),
    show: false,
    title: app.getName(),
    backgroundColor: '#f8fafc',
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  setupSavedLogin(win, origin);
  const contents = win.webContents;
  let lastAppUrl = startUrl(origin);
  let zoomLevel = state.zoomLevel;

  const reveal = () => {
    if (win.isVisible()) return;
    if (state.maximized) win.maximize();
    win.show();
    win.focus();
  };
  win.once('ready-to-show', reveal);
  setTimeout(reveal, 5000);

  const showOffline = (url, reason) => {
    const query = { url: isAppUrl(origin, url) ? url : lastAppUrl, reason };
    win.loadFile(OFFLINE_PAGE, { query });
  };
  const reload = ignoreCache => {
    if (contents.getURL().startsWith('file:')) contents.loadURL(lastAppUrl);
    else if (ignoreCache) contents.reloadIgnoringCache();
    else contents.reload();
  };
  const zoom = direction => {
    zoomLevel = nextZoom(zoomLevel, direction);
    contents.setZoomLevel(zoomLevel);
  };

  // Only the admin pages of the configured server load in this window; https links elsewhere open in the browser.
  const keepInside = (event, url) => {
    if (isAppUrl(origin, url)) return;
    event.preventDefault();
    openOutside(url);
  };
  contents.on('will-navigate', keepInside);
  contents.on('will-redirect', keepInside);
  contents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(origin, url)) contents.loadURL(url);
    else openOutside(url);
    return { action: 'deny' };
  });

  contents.on('did-navigate', (_event, url, httpResponseCode) => {
    if (!isAppUrl(origin, url)) return;
    lastAppUrl = url;
    // A server restart answers 502 for a few seconds; show the retry page instead of a blank one.
    if (httpResponseCode >= 500) showOffline(url, 'server');
  });
  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame && isAppUrl(origin, url)) lastAppUrl = url;
  });
  contents.on('did-fail-load', (_event, errorCode, _description, url, isMainFrame) => {
    // -3 is an aborted navigation, e.g. one replaced by the next click.
    if (!isMainFrame || errorCode === -3 || !isAppUrl(origin, url)) return;
    showOffline(url, errorCode <= -200 && errorCode > -300 ? 'certificate' : 'network');
  });
  contents.on('render-process-gone', () => contents.loadURL(lastAppUrl));

  contents.on('did-finish-load', () => contents.setZoomLevel(zoomLevel));
  contents.on('zoom-changed', (_event, direction) => zoom(direction));

  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
    if (key === 'F5' || (mod && key === 'r')) reload(input.shift || (mod && key === 'F5'));
    else if (mod && (key === '=' || key === '+')) zoom('in');
    else if (mod && (key === '-' || key === '_')) zoom('out');
    else if (mod && key === '0') zoom('reset');
    else if (key === 'F11') win.setFullScreen(!win.isFullScreen());
    else if (!app.isPackaged && (key === 'F12' || (mod && input.shift && key === 'i'))) contents.toggleDevTools();
    else return;
    event.preventDefault();
  });

  // Electron has no right-click menu of its own; give text fields the usual cut/copy/paste.
  contents.on('context-menu', (_event, params) => {
    const flags = params.editFlags;
    const items = params.isEditable
      ? [
        { role: 'cut', label: '剪切', enabled: flags.canCut },
        { role: 'copy', label: '复制', enabled: flags.canCopy },
        { role: 'paste', label: '粘贴', enabled: flags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', label: '全选', enabled: flags.canSelectAll },
      ]
      : params.selectionText.trim() ? [{ role: 'copy', label: '复制' }] : [];
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  win.on('close', () => writeState({ maximized: win.isMaximized() || win.isFullScreen(), zoomLevel }));

  contents.loadURL(lastAppUrl);
  return win;
}

function start() {
  let origin;
  try {
    origin = resolveOrigin({ packaged: app.isPackaged, configured: pkg.kunlunOrigin, override: process.env.KUNLUN_DESKTOP_ORIGIN });
  } catch (error) {
    dialog.showErrorBox(app.getName(), error.message);
    app.quit();
    return;
  }
  if (process.platform === 'win32' && pkg.kunlunAppId) app.setAppUserModelId(pkg.kunlunAppId);
  // Windows keeps Ctrl+C/V without a menu; macOS (local debugging only) needs the Edit menu for them.
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]) : null);
  setupSession(origin);
  createWindow(origin);
}

app.on('web-contents-created', (_event, contents) => contents.on('will-attach-webview', event => event.preventDefault()));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Opening the shortcut again brings the existing window forward instead of a second copy.
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(start);
}
