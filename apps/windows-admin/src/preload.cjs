'use strict';
/**
 * Remembers the admin login on this computer, like a browser's saved password: a 记住密码 box on the
 * login page, the form filled in from the saved login, and the login saved once it has worked.
 * Runs in an isolated world, so the page's own scripts cannot reach ipcRenderer through it; the main
 * process also checks that requests come from the admin pages of the configured server.
 * Sandboxed preloads cannot load local files, so everything it needs is in this one file.
 */
const { ipcRenderer } = require('electron');

const BOX_ID = 'kunlun-desktop-remember';
let setUpForm = null;   // the login form already given a 记住密码 box
let pending = null;     // the last submitted login, saved once the login page goes away

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
  const info = await ipcRenderer.invoke('kunlun:login:get').catch(() => null);
  if (!info?.available || !form.isConnected || form.querySelector('#' + BOX_ID)) return;

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = Boolean(info.saved);
  box.style.cssText = 'width:16px;height:16px;margin:0;flex:none;accent-color:var(--brand-500,#109880)';
  // Unticking forgets the saved login straight away; ticking saves only after a login that works.
  box.addEventListener('change', () => { if (!box.checked) ipcRenderer.invoke('kunlun:login:forget').catch(() => {}); });
  const label = document.createElement('label');
  label.id = BOX_ID;
  label.style.cssText = 'display:flex;align-items:center;gap:8px;font-weight:400;cursor:pointer;user-select:none';
  label.append(box, '记住密码（只保存在这台电脑上）');
  const anchor = form.querySelector('.account-error') || form.querySelector('[type=submit]');
  anchor.parentNode.insertBefore(label, anchor);

  if (info.saved && !username.value && !password.value) {
    setValue(username, info.saved.username);
    setValue(password, info.saved.password);
  }
  form.addEventListener('submit', () => {
    pending = { username: username.value.trim(), password: password.value, remember: box.checked };
  }, true);
}

function check() {
  const found = loginForm();
  if (found && found.form !== setUpForm) setUp(found);
  if (!found && pending) {
    // The login page only goes away once the login has worked.
    const login = pending;
    pending = null;
    if (login.remember) ipcRenderer.invoke('kunlun:login:save', { username: login.username, password: login.password }).catch(() => {});
    else ipcRenderer.invoke('kunlun:login:forget').catch(() => {});
  }
}

window.addEventListener('DOMContentLoaded', () => {
  check();
  new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true });
});
