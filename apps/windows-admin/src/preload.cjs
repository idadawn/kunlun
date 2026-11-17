'use strict';
/**
 * Keeps the shop computer logged in: a 自动登录 box (ticked by default) on the admin login page; once a
 * login with it ticked has worked, the shell remembers it and logs in by itself whenever the login page
 * shows up again (app start, token expiry). After the user logs out or changes the password it fills the
 * form but waits for 登录. Runs in an isolated world, so the page's own scripts cannot reach ipcRenderer;
 * the main process also checks that requests come from the admin pages of the configured server.
 * Sandboxed preloads cannot load local files, so everything it needs is in this one file.
 */
const { ipcRenderer } = require('electron');

const BOX_ID = 'kunlun-desktop-remember';
let setUpForm = null;   // the login form already given a 自动登录 box
let pending = null;     // the last submitted login, reported once the login page goes away
let autoTried = false;  // one automatic attempt per page until a login works, so a stale password cannot loop

const invoke = (channel, value) => ipcRenderer.invoke(channel, value).catch(() => null);

const setValue = (input, value) => {
  // Set through the native setter so React's controlled input sees an input event with a new value.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

function loginForm() {
  const form = document.querySelector('.login-admin form.login-card');
  const username = form?.querySelector('#loginUsername');
  const password = form?.querySelector('#loginPassword');
  return username && password ? { form, username, password } : null;
}

async function setUp({ form, username, password }) {
  setUpForm = form;
  const info = await invoke('kunlun:login:get');
  if (!info?.available || !form.isConnected || form.querySelector('#' + BOX_ID)) return;

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = info.remember;
  box.style.cssText = 'width:16px;height:16px;margin:0;flex:none;accent-color:var(--brand-500,#109880)';
  // Unticking forgets the saved login straight away; ticking saves only after a login that works.
  box.addEventListener('change', () => { if (!box.checked) invoke('kunlun:login:forget'); });
  const label = document.createElement('label');
  label.id = BOX_ID;
  label.style.cssText = 'display:flex;align-items:center;gap:8px;font-weight:400;cursor:pointer;user-select:none';
  label.append(box, '自动登录（在这台电脑上记住密码）');
  const anchor = form.querySelector('.account-error') || form.querySelector('[type=submit]');
  anchor.parentNode.insertBefore(label, anchor);

  form.addEventListener('submit', () => {
    pending = { username: username.value.trim(), password: password.value, remember: box.checked };
  }, true);

  if (info.saved && !username.value && !password.value) {
    if (info.saved.username) setValue(username, info.saved.username);
    if (info.saved.password) setValue(password, info.saved.password);
  }
  if (info.autoLogin && !autoTried && username.value && password.value) {
    autoTried = true;
    // Let React apply the filled-in values before the form submits them.
    setTimeout(() => { if (form.isConnected) form.requestSubmit(); }, 50);
  }
}

function check() {
  const found = loginForm();
  if (found && found.form !== setUpForm) setUp(found);
  if (!found && pending) {
    // The login page only goes away once the login has worked.
    invoke('kunlun:login:succeeded', pending);
    pending = null;
    autoTried = false;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  check();
  new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true });
});
