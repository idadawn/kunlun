// Runs the packaged native API module with wx.request bridged to real HTTPS.
// Each VM is one independent phone session. No demo data or mocked business response is used.
const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm'); const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const access = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const packaged = path.join(root, 'dist/miniprogram');
const config = require(path.join(packaged, 'config.js'));
if (config.mode !== 'api' || config.apiBase !== access.apiBase || new URL(access.apiBase).hostname !== 'kunlun-test.idalee.cn') throw new Error('An API build pointing to the isolated test service is required');
function phone() {
  const storage = new Map(); const modules = new Map();
  const context = vm.createContext({ console, setTimeout, clearTimeout, wx: {
    getStorageSync: k => storage.get(k), setStorageSync: (k,v) => storage.set(k, JSON.parse(JSON.stringify(v))), removeStorageSync: k => storage.delete(k), reLaunch() {},
    request(options) {
      const url = new URL(options.url);
      if (url.origin !== access.apiBase) throw new Error('Unexpected backend');
      if ((!options.method || options.method === 'GET') && options.data) Object.entries(options.data).forEach(([k,v]) => url.searchParams.set(k,v));
      fetch(url, { method: options.method, headers: options.header, ...(options.method === 'POST' || options.method === 'PUT' ? { body: JSON.stringify(options.data) } : {}), signal: AbortSignal.timeout(options.timeout) })
        .then(async response => {
          const text = await response.text(); let data = text;
          try { data = JSON.parse(text); } catch { /* wx.request preserves empty/non-JSON error bodies too. */ }
          options.success({ statusCode: response.status, data });
        }).catch(() => options.fail());
    }
  } });
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} }; modules.set(file, module);
    const fn = vm.runInContext('(function(require,module,exports){' + fs.readFileSync(file, 'utf8') + '\n})', context, { filename: file });
    fn(name => { if (!name.startsWith('.')) throw new Error('Unexpected dependency'); return load(path.resolve(path.dirname(file), name + '.js')); }, module, module.exports);
    return module.exports;
  }
  return load(path.join(packaged, 'lib/api.js'));
}
(async () => {
  const first = phone(), second = phone(), staff = phone();
  await first.login('MEMBER', access.members[0].account, access.members[0].password);
  await second.login('MEMBER', access.members[0].account, access.members[0].password);
  await staff.login('STAFF', access.staff.account, access.staff.password);
  const memberId = first.session().subjectId;
  const [rows, standards] = await first.call('deposits', { memberId });
  assert.equal(rows.length, 2); assert.ok(standards.every(c => c.unitDeposit > 0));
  const address = (await first.call('addresses', { memberId }))[0]; assert.ok(address);
  const marker = 'live-' + Date.now();
  const saved = await first.call('saveAddress', { memberId, contactName: '接口验收', contactPhone: '13800000010', location: '真实接口测试楼', doorNo: marker, isDefault: false });
  assert.ok((await second.call('addresses', { memberId })).some(a => a.id === saved.id));
  const plan = (await first.call('plans')).find(p => p.waterType === 'BUCKET_18_9L' && p.fulfillMode === 'DELIVERY' && p.status === 'ACTIVE');
  const payment = await first.call('createPayment', { planId: plan.id, idempotencyKey: first.key() });
  const before = await second.call('profile', { memberId });
  for (const outcome of ['CANCEL','FAIL']) await first.call('mockPay', { id: payment.id, outcome });
  assert.equal((await second.call('profile', { memberId })).bucketDeliveryTickets, before.bucketDeliveryTickets);
  await first.call('mockPay', { id: payment.id, outcome: 'SUCCESS' }); await first.call('mockPay', { id: payment.id, outcome: 'SUCCESS' });
  assert.equal((await second.call('profile', { memberId })).bucketDeliveryTickets, before.bucketDeliveryTickets + plan.buyQty + plan.giftQty);
  const current = await second.call('profile', { memberId });
  const reserve = await first.call('createOrder', { memberId, waterType: plan.waterType, fulfillMode: 'DELIVERY', orderQty: 1, addressId: saved.id, idempotencyKey: first.key(), remark: marker });
  assert.ok((await staff.call('orders')).rows.some(o => o.id === reserve.id));
  await staff.call('acceptOrder', { id: reserve.id });
  assert.equal((await second.call('orders')).rows.find(o => o.id === reserve.id).status, 'DISPATCHED');
  // Return the same physical count after the first hand-over; otherwise the already-paid deposit covers the first bucket.
  const empty = Math.min(current.heldBuckets, 1);
  await staff.call('fulfillOrder', { id: reserve.id, actualQty: 1, fullOutN: 1, emptyInM: empty });
  assert.equal((await second.call('orders')).rows.find(o => o.id === reserve.id).status, 'COMPLETED');
  const cancel = await first.call('createOrder', { memberId, waterType: plan.waterType, fulfillMode: 'DELIVERY', orderQty: 1, addressId: address.id, idempotencyKey: first.key() });
  await first.call('cancelOrder', { id: cancel.id });
  assert.equal((await second.call('profile', { memberId })).bucketDeliveryTickets, current.bucketDeliveryTickets - 1);
  // Exercise the retail shortfall path used by the 5-bag menu item and collect its deposit once.
  const retail = await first.call('createPayment', { retail: [{ waterType: 'BAG_7_5L', fulfillMode: 'DELIVERY', qty: 5 }], idempotencyKey: first.key() });
  assert.equal(retail.kind, 'RETAIL');
  await first.call('mockPay', { id: retail.id, outcome: 'SUCCESS' });
  const bagOrder = await first.call('createOrder', { memberId, waterType: 'BAG_7_5L', fulfillMode: 'DELIVERY', orderQty: 5, addressId: saved.id, idempotencyKey: first.key() });
  const [coverage] = await staff.call('deposits', { memberId });
  const bag = coverage.find(row => row.containerType === 'BAG');
  const returns = Math.min(bag.heldQty, 5);
  const gap = Math.max(0, bag.heldQty + 5 - returns - bag.paidQty + bag.pendingDamageQty);
  if (gap) {
    const body = { memberId, containerType: 'BAG', quantity: gap, payMethod: 'CASH', idempotencyKey: staff.key() };
    await staff.call('collectDeposit', body); await staff.call('collectDeposit', body);
  }
  await staff.call('acceptOrder', { id: bagOrder.id });
  await staff.call('fulfillOrder', { id: bagOrder.id, actualQty: 5, fullOutN: 5, emptyInM: returns });
  assert.equal((await second.call('orders')).rows.find(o => o.id === bagOrder.id).status, 'COMPLETED');
  const outsider = phone(); await outsider.login('MEMBER', access.members[1].account, access.members[1].password);
  await assert.rejects(outsider.call('profile', { memberId }), e => e.status === 403);
  await assert.rejects(outsider.call('payment', { id: payment.id }), e => e.status === 404);
  await assert.rejects(first.call('acceptOrder', { id: reserve.id }), e => e.status === 403);
  // An explicit logout invalidates another phone's old token for that account.
  await first.logout(); await assert.rejects(second.call('me'), e => e.status === 401);
  console.log(JSON.stringify({ passed: true, backend: access.apiBase, checks: ['password login','cross-phone address persistence','cancel/fail/success payment','idempotent credit','cross-phone order visibility','accept/fulfill/cancel','retail shortfall and deposit collection','member ownership and staff permissions','logout revocation'], orderId: reserve.id, paymentId: payment.id }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
