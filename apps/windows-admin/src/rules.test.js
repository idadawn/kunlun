import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ORIGIN, clampZoom, externalUrl, isAppUrl, nextZoom, normalizeLogin, parseOrigin, resolveOrigin, savedLoginFor, startUrl } from './rules.js';

test('installed copies use the packaged https server and ignore the source-only override', () => {
  assert.equal(resolveOrigin({ packaged: true }), DEFAULT_ORIGIN);
  assert.equal(resolveOrigin({ packaged: true, configured: 'https://kunlun-test.idalee.cn' }), 'https://kunlun-test.idalee.cn');
  assert.equal(resolveOrigin({ packaged: true, configured: DEFAULT_ORIGIN, override: 'http://127.0.0.1:5173' }), DEFAULT_ORIGIN);
  assert.equal(resolveOrigin({ packaged: false, override: 'http://127.0.0.1:5173' }), 'http://127.0.0.1:5173');
  assert.equal(resolveOrigin({ packaged: false }), DEFAULT_ORIGIN);
  assert.equal(startUrl(DEFAULT_ORIGIN), 'https://kunlun.idalee.cn/admin');
});

test('server addresses must be bare https origins; plain http only for local debugging', () => {
  assert.equal(parseOrigin('https://kunlun.idalee.cn/'), DEFAULT_ORIGIN);
  for (const bad of ['http://kunlun.idalee.cn', 'https://kunlun.idalee.cn/admin', 'https://a:b@kunlun.idalee.cn', 'https://kunlun.idalee.cn?x=1', 'file:///C:/admin', 'kunlun.idalee.cn']) {
    assert.throws(() => parseOrigin(bad), Error, bad);
  }
  assert.throws(() => parseOrigin('http://127.0.0.1:5173'));
  assert.equal(parseOrigin('http://127.0.0.1:5173', { allowLoopbackHttp: true }), 'http://127.0.0.1:5173');
  assert.throws(() => parseOrigin('http://192.168.1.5:5173', { allowLoopbackHttp: true }));
});

test('only admin pages on the configured server open inside the window', () => {
  const ok = ['/', '/admin', '/admin/', '/admin/plans', '/admin/members?page=2', '/admin/orders#top'];
  for (const path of ok) assert.ok(isAppUrl(DEFAULT_ORIGIN, DEFAULT_ORIGIN + path), path);
  const blocked = [
    DEFAULT_ORIGIN + '/staff', DEFAULT_ORIGIN + '/member/records', DEFAULT_ORIGIN + '/admin.html', DEFAULT_ORIGIN + '/administrator',
    DEFAULT_ORIGIN + '/api/auth/me', 'http://kunlun.idalee.cn/admin', 'https://kunlun-test.idalee.cn/admin',
    'https://kunlun.idalee.cn@evil.example/admin', 'https://kunlun.idalee.cn.evil.example/admin', 'file:///C:/admin', 'blob:https://kunlun.idalee.cn/1', 'not a url',
  ];
  for (const url of blocked) assert.equal(isAppUrl(DEFAULT_ORIGIN, url), false, url);
});

test('only plain https links are handed to the system browser', () => {
  assert.equal(externalUrl('https://www.pgyer.com/abc'), 'https://www.pgyer.com/abc');
  for (const bad of ['http://example.com', 'tel:13800000000', 'mailto:a@b.c', 'file:///C:/Windows', 'javascript:alert(1)', 'https://u:p@example.com', 'ms-settings:']) {
    assert.equal(externalUrl(bad), null, bad);
  }
});

test('only well-formed logins are remembered, and only for the server they were saved on', () => {
  assert.deepEqual(normalizeLogin({ username: ' yg0001 ', password: ' p w ' }), { username: 'yg0001', password: ' p w ' });
  for (const bad of [null, 'x', {}, { username: 'a' }, { password: 'b' }, { username: ' ', password: 'b' }, { username: 'a', password: '' },
    { username: 'a'.repeat(33), password: 'b' }, { username: 'a', password: 'b'.repeat(129) }, { username: 1, password: 2 }]) {
    assert.equal(normalizeLogin(bad), null, JSON.stringify(bad));
  }
  const saved = { origin: DEFAULT_ORIGIN, username: 'yg0001', password: 'secret123' };
  assert.deepEqual(savedLoginFor(DEFAULT_ORIGIN, saved), { username: 'yg0001', password: 'secret123' });
  assert.equal(savedLoginFor('https://kunlun-test.idalee.cn', saved), null);
  assert.equal(savedLoginFor(DEFAULT_ORIGIN, { username: 'yg0001', password: 'secret123' }), null);
  assert.equal(savedLoginFor(DEFAULT_ORIGIN, null), null);
});

test('zoom moves in half steps and stays within bounds', () => {
  assert.equal(nextZoom(0, 'in'), 0.5);
  assert.equal(nextZoom(0, 'out'), -0.5);
  assert.equal(nextZoom(3, 'reset'), 0);
  assert.equal(nextZoom(5, 'in'), 5);
  assert.equal(nextZoom(-3, 'out'), -3);
  assert.equal(clampZoom(9), 5);
  assert.equal(clampZoom('1.5'), 1.5);
  for (const bad of [undefined, null, 'x', NaN]) assert.equal(clampZoom(bad), 0, String(bad));
});
