// Explicit test-only setup through business APIs. Credentials come from a private file, never source.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const [configPath] = process.argv.slice(2);
if (!configPath) throw new Error('Usage: node deploy/test/seed.mjs PRIVATE_ACCESS_JSON');
const access = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const base = new URL(access.apiBase);
if (base.protocol !== 'https:' || base.hostname !== 'kunlun-test.idalee.cn') throw new Error('Refusing to seed a non-test destination');
const call = async (path, method = 'GET', data, token) => {
  const response = await fetch(base.origin + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(20000) });
  const value = await response.json();
  if (!response.ok) throw new Error(path + ': HTTP ' + response.status + ' ' + (value.error || 'request failed'));
  return value;
};
const server = await call('/api/mini-config');
assert.equal(server.service, 'kunlun.waterstation'); assert.equal(server.environment, 'test'); assert.equal(server.paymentProvider, 'MOCK');
const login = (type, user) => call('/api/auth/' + type + '/login', 'POST', { account: user.account, password: user.password });
const admin = await login('staff', access.admin);
assert.equal(admin.role, 'ADMIN');
const staff = await call('/api/staff', 'GET', undefined, admin.accessToken);
if (!staff.some(s => s.username === access.staff.account)) await call('/api/staff', 'POST', { name: '联调店员', phone: '13900000010', username: access.staff.account, password: access.staff.password, role: 'CLERK' }, admin.accessToken);
assert.equal((await login('staff', access.staff)).role, 'CLERK');
for (const [i, user] of access.members.entries()) {
  const phone = '1380000001' + i;
  const rows = await call('/api/members?q=' + phone, 'GET', undefined, admin.accessToken);
  let member = rows.find(m => m.phone === phone);
  if (!member) {
    member = await call('/api/members', 'POST', { name: '联调会员' + (i + 1), phone, defaultAddress: '测试小区 ' + (i + 1) + ' 栋', doorNo: '101 室' }, admin.accessToken);
    await call('/api/accounts/MEMBER/' + member.id + '/credentials', 'PUT', { username: user.account, password: user.password }, admin.accessToken);
  }
  user.subjectId = member.id;
  assert.equal((await login('member', user)).subjectId, member.id);
  // Usable starting balances, recorded as explicit test-only offline registration.
  const plans = await call('/api/plans', 'GET', undefined, admin.accessToken);
  const plan = plans.find(p => p.waterType === 'BUCKET_18_9L' && p.fulfillMode === 'DELIVERY' && p.price === 100 && p.status === 'ACTIVE');
  assert.ok(plan);
  await call('/api/recharges', 'POST', { memberId: member.id, planId: plan.id, payMethod: 'CASH', idempotencyKey: 'test-setup-tickets-' + i }, admin.accessToken);
  await call('/api/deposits/collect', 'POST', { memberId: member.id, containerType: 'BUCKET', quantity: 1, payMethod: 'CASH', idempotencyKey: 'test-setup-deposit-' + i }, admin.accessToken);
}
for (const containerType of ['BUCKET', 'BAG']) await call('/api/containers/inventory', 'POST', { containerType, action: 'RECEIVE', quantity: 200, reason: '小程序独立测试环境初始化', idempotencyKey: 'test-setup-stock-' + containerType }, admin.accessToken);
fs.writeFileSync(configPath, JSON.stringify(access, null, 2) + '\n', { mode: 0o600 });
console.log('Test-only setup complete: administrator, clerk, two members, initial tickets, deposits and inventory.');
