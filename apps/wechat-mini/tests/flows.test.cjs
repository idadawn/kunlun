const test = require('node:test'); const assert = require('node:assert/strict');
const store = new Map();
global.wx = { getStorageSync: k => store.has(k) ? structuredClone(store.get(k)) : '', setStorageSync: (k,v) => store.set(k, structuredClone(v)), removeStorageSync: k => store.delete(k) };
const demo = require('../src/lib/demo');
const api = require('../src/lib/api');
const { pay } = require('../src/lib/payment');
const member = demo.login('MEMBER'); const staff = demo.login('STAFF');
const call = (action, p, user = member) => demo.call(action, p, user);
const order = key => ({ memberId: member.subjectId, waterType: 'BUCKET_18_9L', fulfillMode: 'DELIVERY', orderQty: 1, addressId: 'demo-address', idempotencyKey: key });
test.beforeEach(() => { store.clear(); });
test('payment cancel/failure changes no balance; repeated success credits exactly once', async () => {
  const before = await call('profile', { memberId: member.subjectId });
  const p = await call('createPayment', { planId: 'bucket-delivery', idempotencyKey: 'pay-1' });
  for (const outcome of ['CANCEL','FAIL']) { await call('mockPay', { id: p.id, outcome }); assert.deepEqual(await call('profile', { memberId: member.subjectId }), before); }
  await Promise.all([1,2,3].map(() => call('mockPay', { id: p.id, outcome: 'SUCCESS' })));
  assert.equal((await call('profile', { memberId: member.subjectId })).bucketDeliveryTickets, before.bucketDeliveryTickets + 13);
  assert.equal((await call('mockPay', { id: p.id, outcome: 'CANCEL' })).status, 'SUCCESS');
  assert.equal((await call('createPayment', { planId: 'bucket-delivery', idempotencyKey: 'pay-1' })).id, p.id);
  await assert.rejects(call('createPayment', { planId: 'bucket-pickup', idempotencyKey: 'pay-1' }), /其他购买/);
});
test('member order reserves tickets, duplicate request and cancel do not double debit/refund', async () => {
  const p = order('order-1'); const created = await call('createOrder', p);
  assert.equal((await call('createOrder', p)).id, created.id);
  assert.equal((await call('profile', { memberId: member.subjectId })).bucketDeliveryTickets, 11);
  await call('cancelOrder', { id: created.id }); await call('cancelOrder', { id: created.id });
  assert.equal((await call('profile', { memberId: member.subjectId })).bucketDeliveryTickets, 12);
  await assert.rejects(call('createOrder', Object.assign({}, p, { orderQty: 2 })), /其他订单/);
});
test('roles are isolated; staff can accept and fulfill with actual container checks', async () => {
  const created = await call('createOrder', order('delivery'));
  await assert.rejects(call('acceptOrder', { id: created.id }), /员工权限/);
  await assert.rejects(call('profile', { memberId: 'someone-else' }), /其他会员/);
  await assert.rejects(call('createPayment', { planId: 'bucket-delivery', idempotencyKey: 'staff-pay' }, staff), /会员身份/);
  await call('acceptOrder', { id: created.id }, staff);
  await assert.rejects(call('fulfillOrder', { id: created.id, actualQty: 1, fullOutN: 1, emptyInM: 0 }, staff), /押金/);
  await call('fulfillOrder', { id: created.id, actualQty: 1, fullOutN: 1, emptyInM: 1 }, staff);
  assert.equal((await call('orders')).rows[0].status, 'COMPLETED');
});
test('pickup checks verification code and ticket balance cannot go negative', async () => {
  await assert.rejects(call('createOrder', Object.assign(order('too-many'), { orderQty: 99 })), /水票不足/);
  const created = await call('createOrder', Object.assign(order('pickup'), { fulfillMode: 'PICKUP' }));
  const p = { id: created.id, actualQty: 1, fullOutN: 1, emptyInM: 1, pickupCode: 'wrong' };
  await assert.rejects(call('fulfillOrder', p, staff), /核销码/);
  await call('fulfillOrder', Object.assign({}, p, { pickupCode: created.pickupCode }), staff);
  assert.equal((await call('orders')).rows[0].status, 'COMPLETED');
});
test('payment UI uses authoritative query and mock never invokes wx.requestPayment', async () => {
  await api.login('MEMBER'); let realCalls = 0;
  wx.requestPayment = () => { realCalls++; throw new Error('must not call real pay'); };
  wx.showActionSheet = ({ success }) => success({ tapIndex: 0 });
  const p = await api.call('createPayment', { planId: 'bucket-delivery', idempotencyKey: 'ui-pay' });
  assert.equal((await pay(p)).status, 'SUCCESS'); assert.equal(realCalls, 0);
});
test('front-end success cannot fabricate payment settlement', async () => {
  await api.login('MEMBER'); const p = await api.call('createPayment', { planId: 'bucket-delivery', idempotencyKey: 'ui-real' });
  wx.requestPayment = ({ success }) => success({ errMsg: 'requestPayment:ok' });
  await assert.rejects(pay(Object.assign({}, p, { provider: 'WECHAT', paymentParameters: { signType: 'RSA', timeStamp: '1', nonceStr: 'n', package: 'prepay_id=test', paySign: 'not-a-real-signature' } })), /确认中/);
  assert.equal((await api.call('payment', { id: p.id })).status, 'NOTPAY');
});
test('payment buttons reject a second concurrent action and recover after failure', async () => {
  const { run } = require('../src/lib/ui');
  const page = { data: { busy: false, error: '' }, setData(patch) { Object.assign(this.data, patch); } };
  let release; let calls = 0;
  const task = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const first = run(page, task); await run(page, task);
  assert.equal(calls, 1); assert.equal(page.data.busy, true);
  release(); await first; assert.equal(page.data.busy, false);
  await run(page, () => Promise.reject(new Error('网络失败')));
  assert.equal(page.data.error, '网络失败'); assert.equal(page.data.busy, false);
});
test('order times use station time in Asia/Shanghai rather than UTC date slicing', () => {
  const { orderView } = require('../src/lib/ui');
  assert.equal(orderView({ createdAt: '2026-10-28T21:32:00Z', waterType: 'BUCKET_18_9L', status: 'PENDING', fulfillMode: 'DELIVERY' }).timeText, '2026-10-29 05:32');
});
