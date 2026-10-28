// Entirely local fixtures. This module is omitted from API builds.
// No network calls and no real customer data or merchant credentials.
const KEY = 'kunlun-mini-demo-v1';
const clone = value => JSON.parse(JSON.stringify(value));
const bucket = 'BUCKET_18_9L';
const bag = 'BAG_7_5L';
const permission = action => 'kunlun.waterstation:' + action;
function initial() {
  return {
    products: [
      { waterType: bucket, name: '绿麒麟桶装水', capacityLiters: 15, packaging: '循环水桶', deliveryMinimum: 1, deliveryFee: 0 },
      { waterType: bag, name: '绿麒麟袋装水', capacityLiters: 5, packaging: '循环水袋', deliveryMinimum: 3, deliveryFee: 0 }
    ],
    plans: [
      { id: 'bucket-delivery', name: '桶装配送 · 家庭包', waterType: bucket, fulfillMode: 'DELIVERY', price: 100, buyQty: 13, giftQty: 0, status: 'ACTIVE' },
      { id: 'bucket-pickup', name: '桶装自提 · 实惠包', waterType: bucket, fulfillMode: 'PICKUP', price: 100, buyQty: 16, giftQty: 0, status: 'ACTIVE' },
      { id: 'bag-delivery', name: '袋装配送 · 轻享包', waterType: bag, fulfillMode: 'DELIVERY', price: 100, buyQty: 40, giftQty: 0, status: 'ACTIVE' },
      { id: 'bag-pickup', name: '袋装自提 · 轻享包', waterType: bag, fulfillMode: 'PICKUP', price: 100, buyQty: 50, giftQty: 0, status: 'ACTIVE' }
    ],
    member: { id: 'demo-member', name: '体验会员', memberNo: 'TEST001', phone: '13800000000', bucketDeliveryTickets: 12, bucketPickupTickets: 8, bagDeliveryTickets: 20, bagPickupTickets: 10, heldBuckets: 1, heldBags: 0, depositAmount: 50 },
    addresses: [{ id: 'demo-address', memberId: 'demo-member', contactName: '体验会员', contactPhone: '13800000000', location: '演示花园 1 栋', doorNo: '101 室', fullAddress: '演示花园 1 栋 101 室', isDefault: true }],
    orders: [], payments: [], requests: {}, sequence: 1
  };
}
function read() { return wx.getStorageSync(KEY) || initial(); }
function save(db) { wx.setStorageSync(KEY, db); }
function column(water, mode) { return (water === bucket ? 'bucket' : 'bag') + (mode === 'DELIVERY' ? 'Delivery' : 'Pickup') + 'Tickets'; }
function fail(text) { throw new Error(text); }
function own(user, memberId) { if (user.subjectType === 'MEMBER' && user.subjectId !== memberId) fail('不能访问其他会员'); }
function staff(user) { if (user.subjectType !== 'STAFF') fail('需要员工权限'); }
function id(db, prefix) { return prefix + String(db.sequence++).padStart(6, '0'); }
function login(subjectType) {
  if (!['MEMBER', 'STAFF'].includes(subjectType)) fail('身份无效');
  return { subjectType, subjectId: subjectType === 'STAFF' ? 'demo-staff' : 'demo-member', displayName: subjectType === 'STAFF' ? '体验店员' : '体验会员', codeOrNo: subjectType === 'STAFF' ? 'TEST-YG01' : 'TEST001', role: subjectType === 'STAFF' ? 'CLERK' : 'MEMBER', permissions: subjectType === 'STAFF' ? ['order:create','order:accept','order:fulfill','member:read'].map(permission) : [], accessToken: 'local-demo-only' };
}
async function call(action, payload, user) {
  if (!user) fail('请先登录');
  const db = read(); const p = payload || {};
  let result;
  switch (action) {
    case 'me': return clone(user);
    case 'products': return clone(db.products);
    case 'plans': return clone(db.plans);
    case 'profile': own(user, p.memberId); if (p.memberId !== db.member.id) fail('会员不存在'); return clone(db.member);
    case 'addresses': own(user, p.memberId); return clone(db.addresses);
    case 'saveAddress': {
      own(user, p.memberId);
      if (!p.contactName || !/^1\d{10}$/.test(p.contactPhone) || !p.location || !p.doorNo) fail('请填写完整地址、联系人和手机号');
      const address = Object.assign({}, p, { id: p.id || id(db, 'ADDR'), fullAddress: p.location + ' ' + p.doorNo });
      if (!db.addresses.length) address.isDefault = true;
      db.addresses = db.addresses.filter(a => a.id !== address.id).map(a => Object.assign({}, a, { isDefault: address.isDefault ? false : a.isDefault }));
      db.addresses.push(address); result = address; break;
    }
    case 'members': staff(user); return { rows: [db.member].filter(m => !p.q || (m.name + m.phone + m.memberNo).includes(p.q)), total: 1 };
    case 'orders': {
      if (p.memberId) own(user, p.memberId);
      const rows = db.orders.filter(o => (user.subjectType !== 'MEMBER' || o.memberId === user.subjectId) && (!p.status || o.status === p.status) && (!p.pickupCode || o.pickupCode === p.pickupCode));
      const page = p.page || 1; return clone({ rows: rows.slice((page - 1) * 20, page * 20), total: rows.length });
    }
    case 'createOrder': {
      own(user, p.memberId);
      if (p.memberId !== db.member.id) fail('会员不存在');
      if (!p.idempotencyKey) fail('缺少请求标识');
      if (db.requests[p.idempotencyKey]) {
        const prior = db.requests[p.idempotencyKey];
        if (prior.input !== JSON.stringify(p)) fail('请求标识已用于其他订单');
        return clone(prior.result);
      }
      const product = db.products.find(x => x.waterType === p.waterType);
      if (!product || !['DELIVERY','PICKUP'].includes(p.fulfillMode) || !Number.isInteger(p.orderQty) || p.orderQty < 1) fail('订水数量或水品无效');
      if (p.fulfillMode === 'DELIVERY' && p.orderQty < product.deliveryMinimum) fail(product.deliveryMinimum + '份起送');
      const col = column(p.waterType, p.fulfillMode);
      if (db.member[col] < p.orderQty) fail('水票不足，请先购买对应水票');
      const addr = p.fulfillMode === 'DELIVERY' ? db.addresses.find(a => a.id === p.addressId) : null;
      if (p.fulfillMode === 'DELIVERY' && !addr) fail('请选择收货地址');
      const orderId = id(db, 'TEST');
      result = { id: orderId, orderNo: orderId, memberId: p.memberId, waterType: p.waterType, fulfillMode: p.fulfillMode, orderQty: p.orderQty, reservedQty: p.orderQty, status: 'PENDING', pickupCode: p.fulfillMode === 'PICKUP' ? String(100000 + db.sequence) : null, addressSnapshot: addr ? { contactName: addr.contactName, contactPhone: addr.contactPhone, address: addr.fullAddress } : { contactName: db.member.name, contactPhone: db.member.phone, address: '门店自提' }, productSnapshot: { waterLabel: product.name }, remark: p.remark || '', createdAt: new Date().toISOString() };
      db.member[col] -= p.orderQty; db.orders.unshift(result);
      db.requests[p.idempotencyKey] = { input: JSON.stringify(p), result }; break;
    }
    case 'cancelOrder': {
      const order = db.orders.find(o => o.id === p.id); if (!order) fail('订单不存在'); own(user, order.memberId);
      if (order.status === 'CANCELLED') return clone(order);
      if (order.status !== 'PENDING') fail('当前水单不能取消');
      db.member[column(order.waterType, order.fulfillMode)] += order.orderQty;
      order.status = 'CANCELLED'; order.reservedQty = 0; result = order; break;
    }
    case 'acceptOrder': {
      staff(user); const order = db.orders.find(o => o.id === p.id);
      if (!order || order.fulfillMode !== 'DELIVERY' || !['PENDING','DISPATCHED'].includes(order.status)) fail('当前水单不能接单');
      order.status = 'DISPATCHED'; result = order; break;
    }
    case 'fulfillOrder': {
      staff(user); const order = db.orders.find(o => o.id === p.id); if (!order) fail('水单不存在');
      if (order.status === 'COMPLETED') return clone(order);
      if (order.status === 'CANCELLED') fail('水单已取消');
      if (order.fulfillMode === 'PICKUP' && p.pickupCode !== order.pickupCode) fail('核销码不正确');
      if (p.actualQty !== order.orderQty || p.fullOutN !== p.actualQty || !Number.isInteger(p.emptyInM) || p.emptyInM < 0) fail('本测试流程按订单数量交付，请核对换回数量');
      const held = order.waterType === bucket ? 'heldBuckets' : 'heldBags';
      const after = db.member[held] + p.fullOutN - p.emptyInM;
      if (after < 0 || after > (order.waterType === bucket ? 1 : 0)) fail('回收数量或押金覆盖不足，请先由门店核实');
      db.member[held] = after; order.reservedQty = 0; order.status = 'COMPLETED'; result = order; break;
    }
    case 'createPayment': {
      if (user.subjectType !== 'MEMBER') fail('请使用会员身份买水票');
      const previous = db.payments.find(x => x.idempotencyKey === p.idempotencyKey);
      if (previous) { if (previous.planId !== p.planId) fail('请求标识已用于其他套餐'); return clone(previous); }
      const plan = db.plans.find(x => x.id === p.planId && x.status === 'ACTIVE'); if (!plan || !p.idempotencyKey) fail('套餐或请求标识无效');
      result = { id: id(db, 'PAYTEST'), memberId: user.subjectId, planId: plan.id, plan: clone(plan), amountFen: Math.round(plan.price * 100), status: 'NOTPAY', provider: 'MOCK', idempotencyKey: p.idempotencyKey };
      db.payments.unshift(result); break;
    }
    case 'payment': { const pay = db.payments.find(x => x.id === p.id); if (!pay) fail('支付单不存在'); own(user, pay.memberId); return clone(pay); }
    case 'payments': return clone(db.payments.filter(x => x.memberId === user.subjectId));
    case 'mockPay': {
      if (user.subjectType !== 'MEMBER') fail('仅会员可支付');
      const pay = db.payments.find(x => x.id === p.id); if (!pay) fail('支付单不存在'); own(user, pay.memberId);
      if (!['SUCCESS','CANCEL','FAIL'].includes(p.outcome)) fail('测试结果无效');
      if (pay.status === 'SUCCESS') return clone(pay);
      if (p.outcome === 'SUCCESS') {
        db.member[column(pay.plan.waterType, pay.plan.fulfillMode)] += pay.plan.buyQty + pay.plan.giftQty;
        pay.status = 'SUCCESS';
      }
      result = pay; break;
    }
    default: fail('测试能力暂不支持：' + action);
  }
  save(db); return clone(result);
}
module.exports = { login, call, initial, column };
