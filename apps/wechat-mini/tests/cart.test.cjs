const test = require('node:test'); const assert = require('node:assert/strict');
const store = new Map();
global.wx = { getStorageSync: k => store.has(k) ? structuredClone(store.get(k)) : '', setStorageSync: (k,v) => store.set(k, structuredClone(v)), removeStorageSync: k => store.delete(k) };
const cart = require('../src/lib/cart');
const demo = require('../src/lib/demo');
const { orderView } = require('../src/lib/ui');
const member = demo.login('MEMBER'); const staff = demo.login('STAFF');
const call = (action, p, user = member) => demo.call(action, p, user);
const fixtures = demo.initial();
const bucket = 'BUCKET_18_9L'; const bag = 'BAG_7_5L';
const draft = (mode, items) => ({ mode, cart: Object.assign({}, items), addressId: '', slot: 0, remark: '' });
const row = (items, water) => items.find(i => i.waterType === water);
test.beforeEach(() => { store.clear(); });

test('menu: first tap adds the delivery minimum and going below it removes the item', () => {
  const items = cart.menu(fixtures.products, fixtures.member, draft('DELIVERY'), true);
  const bagRow = row(items, bag);
  assert.equal(bagRow.priceText, '5'); assert.equal(bagRow.minTag, '5袋起送'); assert.equal(bagRow.tickets, 0);
  assert.equal(cart.step(bagRow, 1), 5);
  assert.equal(cart.step(Object.assign({}, bagRow, { qty: 5 }), -1), 0);
  assert.equal(cart.step(Object.assign({}, bagRow, { qty: 6 }), -1), 5);
  // Buckets have no retail price: tickets cap the quantity.
  const bucketRow = row(items, bucket);
  assert.equal(bucketRow.priceFen, 0); assert.equal(bucketRow.max, 12); assert.equal(bucketRow.minTag, '');
  assert.equal(cart.step(Object.assign({}, bucketRow, { qty: 12 }), 1), 12);
  // Pickup has no minimum and uses pickup tickets.
  const pickup = cart.menu(fixtures.products, fixtures.member, draft('PICKUP'), true);
  assert.equal(row(pickup, bag).min, 1); assert.equal(row(pickup, bucket).tickets, 8);
});

test('without retail sale a product the member has no tickets for cannot be added', () => {
  const items = cart.menu(fixtures.products, fixtures.member, draft('DELIVERY'), false);
  assert.equal(row(items, bag).soldOut, true);
  assert.equal(row(items, bag).priceText, '');
  assert.equal(row(items, bucket).soldOut, false);
});

test('summary uses tickets first and prices only the shortfall at retail', () => {
  const profile = Object.assign({}, fixtures.member, { bagDeliveryTickets: 3 });
  const s = cart.summary(cart.menu(fixtures.products, profile, draft('DELIVERY', { [bucket]: 2, [bag]: 5 }), true), 'DELIVERY');
  assert.equal(s.count, 7); assert.equal(s.ready, true); assert.equal(s.blocker, '');
  assert.deepEqual(s.lines.map(l => [l.waterType, l.useTickets, l.buyQty, l.amountFen]), [[bucket, 2, 0, 0], [bag, 3, 2, 1000]]);
  assert.equal(s.amountText, '10.00'); assert.equal(s.ticketText, '2 桶 · 3 袋');
  assert.deepEqual(cart.retailLines(s, 'DELIVERY'), [{ waterType: bag, fulfillMode: 'DELIVERY', qty: 2 }]);
  const bar = cart.bar(s, true);
  assert.equal(bar.headline, '¥10.00'); assert.equal(bar.note, '水票抵扣 2 桶 · 3 袋'); assert.equal(bar.ready, true);
});

test('summary blocks below the delivery minimum and sends ticket shortfalls to the ticket shop', () => {
  const below = cart.summary(cart.menu(fixtures.products, fixtures.member, draft('DELIVERY', { [bag]: 3 }), true), 'DELIVERY');
  assert.equal(below.blocker, '5L 袋装水 5袋起送，还差 2 袋'); assert.equal(below.ready, false);
  // Switching to pickup after filling the cart for delivery: 10 buckets, only 8 pickup tickets, no retail price.
  const short = cart.summary(cart.menu(fixtures.products, fixtures.member, draft('PICKUP', { [bucket]: 10 }), true), 'PICKUP');
  assert.equal(short.blocker, '15L 桶装水自提票不足，剩 8 桶'); assert.equal(short.shortTickets, true);
  assert.equal(cart.bar(short, true).action, '买水票'); assert.equal(cart.bar(short, true).ready, true);
  assert.equal(cart.bar(short, false).ready, false);
  assert.equal(cart.bar(cart.summary([], 'DELIVERY'), true).empty, true);
});

test('retail payment credits the shortfall once, only on success, and the order then uses it', async () => {
  const before = await call('profile', { memberId: member.subjectId });
  const retail = [{ waterType: bag, fulfillMode: 'DELIVERY', qty: 5 }];
  const pay = await call('createPayment', { retail, idempotencyKey: 'retail-1' });
  assert.equal(pay.amountFen, 2500); assert.equal(pay.kind, 'RETAIL');
  for (const outcome of ['CANCEL', 'FAIL']) { await call('mockPay', { id: pay.id, outcome }); assert.deepEqual(await call('profile', { memberId: member.subjectId }), before); }
  await Promise.all([1, 2, 3].map(() => call('mockPay', { id: pay.id, outcome: 'SUCCESS' })));
  assert.equal((await call('profile', { memberId: member.subjectId })).bagDeliveryTickets, 5);
  assert.equal((await call('createPayment', { retail, idempotencyKey: 'retail-1' })).id, pay.id);
  await assert.rejects(call('createPayment', { retail: [{ waterType: bag, fulfillMode: 'DELIVERY', qty: 6 }], idempotencyKey: 'retail-1' }), /其他购买/);
  await call('createOrder', { memberId: member.subjectId, waterType: bag, fulfillMode: 'DELIVERY', orderQty: 5, addressId: 'demo-address', idempotencyKey: 'retail-order' });
  assert.equal((await call('profile', { memberId: member.subjectId })).bagDeliveryTickets, 0);
});

test('retail payment refuses products without a retail price and staff payers', async () => {
  await assert.rejects(call('createPayment', { retail: [{ waterType: bucket, fulfillMode: 'DELIVERY', qty: 1 }], idempotencyKey: 'no-price' }), /零售价/);
  await assert.rejects(call('createPayment', { retail: [{ waterType: bag, fulfillMode: 'DELIVERY', qty: 0 }], idempotencyKey: 'zero' }), /数量/);
  await assert.rejects(call('createPayment', { retail: [{ waterType: bag, fulfillMode: 'DELIVERY', qty: 5 }], idempotencyKey: 'staff' }, staff), /会员身份/);
});

test('deposit estimate assumes held empties come back; staff collect it once before hand-over', async () => {
  const [rows, configs] = await call('deposits', { memberId: member.subjectId });
  const pos = cart.positions(rows, configs);
  assert.deepEqual(pos, { BUCKET: { held: 1, covered: 1, unitFen: 5000 }, BAG: { held: 0, covered: 0, unitFen: 500 } });
  const lines = q => cart.summary(cart.menu(fixtures.products, Object.assign({}, fixtures.member, { bagDeliveryTickets: 9 }), draft('DELIVERY', q), true), 'DELIVERY').lines;
  assert.deepEqual(cart.depositDue(lines({ [bucket]: 1 }), pos), { fen: 0, amountText: '0.00', text: '' });
  assert.equal(cart.depositDue(lines({ [bucket]: 2, [bag]: 5 }), pos).amountText, '75.00');
  await assert.rejects(call('deposits', { memberId: 'someone-else' }), /其他会员/);

  store.clear();
  await call('mockPay', { id: (await call('createPayment', { retail: [{ waterType: bag, fulfillMode: 'PICKUP', qty: 2 }], idempotencyKey: 'bag-pay' })).id, outcome: 'SUCCESS' });
  const order = await call('createOrder', { memberId: member.subjectId, waterType: bag, fulfillMode: 'PICKUP', orderQty: 2, idempotencyKey: 'bag-order' });
  const hand = { id: order.id, actualQty: 2, fullOutN: 2, emptyInM: 0, pickupCode: order.pickupCode };
  await assert.rejects(call('fulfillOrder', hand, staff), /押金/);
  await assert.rejects(call('collectDeposit', { memberId: member.subjectId, containerType: 'BAG', quantity: 2, payMethod: 'CASH', idempotencyKey: 'dep' }), /员工权限/);
  const collect = { memberId: member.subjectId, containerType: 'BAG', quantity: 2, payMethod: 'CASH', idempotencyKey: 'dep' };
  await call('collectDeposit', collect, staff); await call('collectDeposit', collect, staff);
  assert.equal((await call('profile', { memberId: member.subjectId })).depositAmount, 60);
  await call('fulfillOrder', hand, staff);
  assert.equal((await call('profile', { memberId: member.subjectId })).heldBags, 2);
});

test('delivery windows follow station time and close an hour before they end', () => {
  const early = cart.slots(Date.parse('2026-10-28T21:32:00Z'));
  assert.equal(early[0], '尽快送达'); assert.equal(early[1], '今天 08:00–10:00'); assert.equal(early.length, 13);
  const late = cart.slots(Date.parse('2026-10-29T08:59:00Z'));
  assert.deepEqual(late.slice(0, 3), ['尽快送达', '今天 16:00–18:00', '今天 18:00–20:00']);
  assert.equal(cart.slots(Date.parse('2026-10-29T11:30:00Z'))[1], '明天 08:00–10:00');
});

test('order status reads as the member sees it', () => {
  const base = { createdAt: '2026-10-28T21:32:00Z', waterType: bag };
  assert.equal(orderView(Object.assign({ status: 'PENDING', fulfillMode: 'PICKUP' }, base)).statusText, '待取水');
  assert.equal(orderView(Object.assign({ status: 'PENDING', fulfillMode: 'DELIVERY' }, base)).statusText, '待接单');
  const v = orderView(Object.assign({ status: 'DISPATCHED', fulfillMode: 'DELIVERY' }, base));
  assert.equal(v.shortTime, '10-29 05:32'); assert.equal(v.unit, '袋'); assert.equal(v.active, true);
  assert.equal(cart.pickAddress([{ id: 'a' }, { id: 'b', isDefault: true }], '').id, 'b');
  assert.equal(cart.pickAddress([{ id: 'a' }, { id: 'b', isDefault: true }], 'a').id, 'a');
});
