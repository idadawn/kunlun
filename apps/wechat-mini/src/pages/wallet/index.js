const api = require('../../lib/api'); const ui = require('../../lib/ui'); const cart = require('../../lib/cart'); const payment = require('../../lib/payment');
const yuan = value => { const n = Number(value); return n % 1 ? n.toFixed(2) : String(n); };
Page({
  data: { water: '', products: [], balances: [], plans: [], payments: [], busy: false, error: '' },
  onShow() { if (ui.guard(this, 'MEMBER')) this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  load() { return ui.run(this, async () => {
    const memberId = api.session().subjectId;
    const [plans, payments, profile, products] = await Promise.all([api.call('plans'), api.call('payments'), api.call('profile', { memberId }), api.call('products')]);
    this.allPlans = plans.filter(p => p.status === 'ACTIVE').map(p => {
      const total = p.buyQty + p.giftQty; const unit = cart.unitOf(p.waterType);
      return Object.assign({}, p, { total, unit, modeText: cart.modeText(p.fulfillMode), priceText: yuan(p.price), unitText: (p.price / total).toFixed(2) });
    }).sort((a, b) => (a.fulfillMode === b.fulfillMode ? a.price - b.price : a.fulfillMode === 'DELIVERY' ? -1 : 1));
    this.setData({
      products,
      water: this.data.water || (products[0] && products[0].waterType) || '',
      balances: products.map(p => ({ waterType: p.waterType, name: p.name, delivery: cart.ticketsFor(profile, p.waterType, 'DELIVERY'), pickup: cart.ticketsFor(profile, p.waterType, 'PICKUP') })),
      payments: payments.map(p => Object.assign({}, p, { title: p.plan.name, amountText: ui.money(p.amountFen), stateText: p.status === 'SUCCESS' ? '已到账' : p.status === 'CLOSED' ? '已关闭' : '待支付', timeText: p.createdAt ? ui.orderView({ createdAt: p.createdAt }).shortTime : '' }))
    });
    this.filterPlans();
  }); },
  pick(e) { this.setData({ water: e.currentTarget.dataset.water }); this.filterPlans(); },
  filterPlans() { this.setData({ plans: (this.allPlans || []).filter(p => p.waterType === this.data.water) }); },
  buy(e) { ui.run(this, async () => {
    const planId = e.currentTarget.dataset.id;
    // Persist the key across timeouts and page recreation to avoid double orders.
    const storageKey = 'kunlun-pay-intent-' + api.config.mode + '-' + api.session().subjectId + '-' + planId;
    let requestKey = wx.getStorageSync(storageKey); if (!requestKey) { requestKey = api.key(); wx.setStorageSync(storageKey, requestKey); }
    const order = await api.call('createPayment', { planId, idempotencyKey: requestKey });
    await payment.pay(order); wx.removeStorageSync(storageKey); wx.showToast({ title: '水票已到账', icon: 'success' });
  }).then(() => this.refreshKeepError()); },
  retry(e) { ui.run(this, async () => {
    const order = await api.call('payment', { id: e.currentTarget.dataset.id });
    await payment.pay(order);
    if (order.planId) wx.removeStorageSync('kunlun-pay-intent-' + api.config.mode + '-' + api.session().subjectId + '-' + order.planId);
    wx.showToast({ title: '水票已到账', icon: 'success' });
  }).then(() => this.refreshKeepError()); },
  async refreshKeepError() { const error = this.data.error; await this.load(); if (error) this.setData({ error }); }
});
