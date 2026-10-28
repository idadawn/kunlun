const api = require('../../lib/api'); const ui = require('../../lib/ui'); const cart = require('../../lib/cart');
const payment = require('../../lib/payment'); const brand = require('../../lib/brand');
Page({
  data: { brand, mode: 'DELIVERY', sum: { lines: [], amountText: '0.00' }, address: null, slots: [], slot: 0, remark: '', deposit: { fen: 0 }, freeDelivery: false, memberName: '', done: null, busy: false, error: '' },
  onLoad(options) {
    this.memberId = decodeURIComponent(options.memberId || '');
    // Per product within this checkout: the idempotency key of its order, so a retry never places it twice.
    this.progress = {};
    this.placed = [];
    this.paid = {};
    this.setData({ slots: cart.slots() });
  },
  onShow() { if (ui.guard(this) && !this.data.done) this.load(); },
  load() { return ui.run(this, () => this.refresh()); },
  async refresh() {
    const staff = api.session().subjectType === 'STAFF';
    if (!this.memberId) throw new Error('请返回重新选择水品');
    if (staff && !api.can('order:create')) throw new Error('当前账号无代客下单权限');
    const memberId = this.memberId;
    const [products, profile, addresses, deposits] = await Promise.all([
      api.call('products'), api.call('profile', { memberId }), api.call('addresses', { memberId }),
      // The deposit line is an estimate; ordering never waits on it.
      api.call('deposits', { memberId }).catch(() => null)
    ]);
    Object.assign(this, { products, profile, addresses, positions: deposits && cart.positions(deposits[0], deposits[1]), retail: !!api.config.retail && !staff });
    this.render();
  },
  render() {
    const d = cart.draft(this.memberId);
    const sum = cart.summary(cart.menu(this.products, this.profile, d, this.retail), d.mode);
    const address = cart.pickAddress(this.addresses, d.addressId);
    this.setData({
      mode: d.mode, sum, slot: d.slot < this.data.slots.length ? d.slot : 0, remark: d.remark, memberName: this.profile.name,
      address: address && Object.assign({}, address, { phoneText: ui.maskPhone(address.contactPhone) }),
      deposit: cart.depositDue(sum.lines, this.positions),
      freeDelivery: this.products.every(p => !Number(p.deliveryFee))
    });
  },
  setMode(e) { if (this.data.busy || !this.products) return; cart.draft(this.memberId).mode = e.currentTarget.dataset.mode; this.render(); },
  chooseAddress() { wx.navigateTo({ url: '/pages/addresses/index?select=1&memberId=' + encodeURIComponent(this.memberId) }); },
  pickSlot(e) { const slot = Number(e.detail.value); cart.draft(this.memberId).slot = slot; this.setData({ slot }); },
  input(e) { cart.draft(this.memberId).remark = e.detail.value; },
  submit() { ui.run(this, async () => {
    // Reload first: tickets bought for this cart, or orders from an earlier attempt, are then already counted.
    await this.refresh();
    const d = cart.draft(this.memberId); const delivery = d.mode === 'DELIVERY';
    let s = this.data.sum;
    if (!s.count) throw new Error('还没有选水品');
    if (s.blocker) throw new Error(s.blocker);
    if (delivery && !this.data.address) throw new Error('请添加收货地址');
    if (s.amountFen) { await this.payShortfall(s, d.mode); s = this.data.sum; }
    const slot = delivery ? this.data.slots[this.data.slot] : null;
    for (const line of s.lines) {
      const body = { memberId: this.memberId, waterType: line.waterType, fulfillMode: d.mode, orderQty: line.qty, addressId: delivery ? this.data.address.id : null, appointmentSlot: slot, remark: d.remark.trim() || null };
      const sig = JSON.stringify(body);
      let p = this.progress[line.waterType];
      if (!p || p.sig !== sig) p = this.progress[line.waterType] = { key: api.key(), sig };
      const order = await api.call('createOrder', Object.assign({ idempotencyKey: p.key }, body));
      delete this.progress[line.waterType]; d.cart[line.waterType] = 0;
      this.placed.push(Object.assign(ui.orderView(Object.assign({}, order, { productSnapshot: { waterLabel: line.name } })), { payText: this.paid[line.waterType] ? '已付 ¥' + this.paid[line.waterType] : '水票抵扣' }));
    }
    d.remark = ''; d.slot = 0;
    this.setData({ done: { pickup: !delivery, slot, orders: this.placed } });
    wx.setNavigationBarTitle({ title: '下单成功' });
  }); },
  // Pays the part tickets cannot cover at retail price; the server credits it as tickets for these orders.
  async payShortfall(s, mode) {
    if (!this.retail) throw new Error('水票不足，请先购买水票');
    const lines = cart.retailLines(s, mode);
    const storageKey = 'kunlun-pay-intent-' + api.config.mode + '-' + this.memberId + '-retail-' + lines.map(l => l.waterType + '.' + l.fulfillMode + '.' + l.qty).join('-');
    let key = wx.getStorageSync(storageKey); if (!key) { key = api.key(); wx.setStorageSync(storageKey, key); }
    const order = await api.call('createPayment', { retail: lines, idempotencyKey: key });
    await payment.pay(order);
    wx.removeStorageSync(storageKey);
    s.lines.forEach(l => { if (l.amountFen) this.paid[l.waterType] = l.amountText; });
    await this.refresh();
    if (this.data.sum.amountFen) throw new Error('支付结果确认中，请稍后重试；请勿重复支付');
  },
  again() {
    if (this.data.staff) wx.navigateBack(); else wx.switchTab({ url: '/pages/home/index' });
  },
  viewOrders() { getApp().orderFilter = ''; wx.switchTab({ url: '/pages/orders/index' }); }
});
