const api = require('../../lib/api'); const ui = require('../../lib/ui'); const payment = require('../../lib/payment');
Page({
  data: { plans: [], payments: [], water: '', mode: '', busy: false, error: '', tickets: [], canMembers: false },
  onShow() { if (ui.guard(this)) this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  load() { return ui.run(this, async () => {
    if (api.session().subjectType === 'STAFF') { this.setData({ canMembers: api.can('member:read') }); return; }
    const [plans, payments, profile] = await Promise.all([api.call('plans'), api.call('payments'), api.call('profile', { memberId: api.session().subjectId })]);
    this.allPlans = plans.filter(p => p.status === 'ACTIVE').map(p => Object.assign({}, p, { priceText: Number(p.price).toFixed(2), typeText: p.waterType === 'BAG_7_5L' ? '袋装 5L' : '桶装 15L', modeText: p.fulfillMode === 'PICKUP' ? '到店自提' : '送水上门' }));
    this.setData({ payments: payments.map(p => Object.assign({}, p, { priceText: ui.money(p.amountFen), stateText: p.status === 'SUCCESS' ? '已到账' : p.status === 'CLOSED' ? '已关闭' : '待支付' })), tickets: [ { label: '桶装 · 配送', qty: profile.bucketDeliveryTickets }, { label: '桶装 · 自提', qty: profile.bucketPickupTickets }, { label: '袋装 · 配送', qty: profile.bagDeliveryTickets }, { label: '袋装 · 自提', qty: profile.bagPickupTickets } ] }); this.filterPlans();
  }); },
  filter(e) { this.setData({ [e.currentTarget.dataset.field]: e.currentTarget.dataset.value }); this.filterPlans(); },
  filterPlans() { this.setData({ plans: (this.allPlans || []).filter(p => (!this.data.water || p.waterType === this.data.water) && (!this.data.mode || p.fulfillMode === this.data.mode)) }); },
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
    wx.removeStorageSync('kunlun-pay-intent-' + api.config.mode + '-' + api.session().subjectId + '-' + order.planId);
    wx.showToast({ title: '水票已到账', icon: 'success' });
  }).then(() => this.refreshKeepError()); },
  async refreshKeepError() { const error = this.data.error; await this.load(); if (error) this.setData({ error }); },
  members() { wx.navigateTo({ url: '/pages/members/index' }); },
  orders() { wx.switchTab({ url: '/pages/orders/index' }); }
});
