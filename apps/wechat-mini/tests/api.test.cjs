const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../src/lib/api.js'), 'utf8');
const capabilities = { service: 'kunlun.waterstation', apiVersion: 1, environment: 'test', environmentLabel: '测试服务', paymentProvider: 'MOCK', retailPaymentsEnabled: true };
const identity = { accessToken: 'server-token', subjectType: 'MEMBER', subjectId: 'member-id', displayName: '接口会员', permissions: [] };
function client(route) {
  const config = { mode: 'api', apiBase: 'https://test.example.invalid', paymentMode: 'disabled', retail: false };
  const storage = new Map(); const calls = []; const launches = [];
  const context = vm.createContext({ module: { exports: {} }, require(name) { if (name === '../config') return config; throw new Error('Demo module must never load'); },
    wx: {
      getStorageSync: k => storage.get(k), setStorageSync: (k,v) => storage.set(k,v), removeStorageSync: k => storage.delete(k), reLaunch: v => launches.push(v.url),
      request(options) { calls.push(options); queueMicrotask(() => { const answer = route(options); if (answer.network) options.fail({ errMsg: 'request:fail' }); else options.success({ statusCode: answer.status || 200, data: answer.data }); }); }
    } });
  vm.runInContext(source, context); return { api: context.module.exports, config, calls, storage, launches };
}
test('API login validates test service before sending account credentials; server grants identity', async () => {
  const c = client(r => ({ data: r.url.endsWith('/mini-config') ? capabilities : identity }));
  await c.api.login('MEMBER', 'member', 'private-test-password');
  assert.equal(c.calls[0].url, 'https://test.example.invalid/api/mini-config');
  assert.equal(c.calls[0].data, undefined);
  assert.equal(c.calls[1].method, 'POST'); assert.equal(c.calls[1].data.account, 'member');
  assert.equal(c.api.session().subjectId, 'member-id'); assert.equal(c.config.retail, true); assert.equal(c.config.paymentMode, 'mock');
  assert.equal(c.calls[1].timeout, 15000);
});
test('production, unrelated service and malformed handshake never receive login credentials', async () => {
  for (const data of [Object.assign({}, capabilities, { environment: 'production' }), Object.assign({}, capabilities, { service: 'other' }), '<html>login</html>']) {
    const c = client(() => ({ data }));
    await assert.rejects(c.api.login('MEMBER', 'member', 'secret'), /测试服务配置不匹配/);
    assert.equal(c.calls.length, 1); assert.equal(c.api.session(), null); assert.equal(c.config.retail, false);
  }
});
test('member deposit estimate uses own endpoint and no station inventory; bearer token and errors survive', async () => {
  const c = client(r => {
    if (r.url.endsWith('/mini-config')) return { data: capabilities };
    if (r.url.endsWith('/login')) return { data: identity };
    if (r.url.endsWith('/deposit-summary')) return { data: [{ containerType: 'BAG', unitDeposit: 5, paidQty: 2, heldQty: 1 }] };
    if (r.url.includes('/orders?')) return { data: { rows: [], total: 0 } };
    return { status: 403, data: { error: '仅可访问本人数据' } };
  });
  await c.api.login('MEMBER', 'member', 'password');
  const deposits = await c.api.call('deposits', { memberId: 'member-id' });
  assert.equal(deposits[1][0].unitDeposit, 5);
  assert.equal(c.calls.some(r => r.url.includes('containers/summary')), false);
  await c.api.call('orders', { status: 'PENDING', page: 2 });
  assert.match(c.calls.at(-1).url, /page=2/); assert.equal(c.calls.at(-1).header.Authorization, 'Bearer server-token');
  await assert.rejects(c.api.call('profile', { memberId: 'other' }), e => e.status === 403 && e.message === '仅可访问本人数据');
});
test('expired token clears session and returns to login; network failure never falls back to demo', async () => {
  const c = client(r => r.url.endsWith('/mini-config') ? { data: capabilities } : r.url.endsWith('/login') ? { data: identity } : { status: 401, data: {} });
  await c.api.login('MEMBER', 'member', 'password');
  await assert.rejects(c.api.call('me'), e => e.status === 401);
  assert.equal(c.api.session(), null); assert.equal(c.launches[0], '/pages/login/index');
  const offline = client(() => ({ network: true }));
  await assert.rejects(offline.api.login('MEMBER', 'member', 'password'), /网络连接失败/);
  assert.equal(offline.api.session(), null); assert.equal(offline.calls.length, 1);
});
test('disabled server payments stay disabled and no payment mutation is sent', async () => {
  const c = client(r => ({ data: r.url.endsWith('/mini-config') ? Object.assign({}, capabilities, { paymentProvider: 'DISABLED', retailPaymentsEnabled: false }) : identity }));
  await c.api.login('MEMBER', 'member', 'password');
  await assert.rejects(c.api.call('createPayment', { planId: 'plan', idempotencyKey: 'key' }), /测试支付尚未启用/);
  assert.equal(c.calls.length, 2); assert.equal((await c.api.call('payments')).length, 0); assert.equal(c.config.retail, false);
});
test('empty HTTP error bodies keep their status instead of becoming a network failure', async () => {
  const c = client(r => r.url.endsWith('/mini-config') ? { data: capabilities } : r.url.endsWith('/login') ? { data: identity } : { status: 404, data: '' });
  await c.api.login('MEMBER', 'member', 'password');
  await assert.rejects(c.api.call('payment', { id: 'missing' }), e => e.status === 404 && !e.message.includes('网络连接失败'));
});
