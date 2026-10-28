const api = require('../../lib/api'); const ui = require('../../lib/ui');
Page({
  data: { user: {}, staff: false, profile: {}, orders: [], products: [], busy: false, error: '', totalTickets: 0, pending: 0, dispatched: 0 },
  onShow() { if (ui.guard(this)) this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  load() { return ui.run(this, async () => {
    await api.call('me');
    const staff = api.session().subjectType === 'STAFF'; this.setData({ staff });
    const result = await Promise.all([api.call('orders'), api.call('products'), staff ? Promise.resolve(null) : api.call('profile', { memberId: api.session().subjectId })]);
    const profile = result[2];
    this.setData({ products: result[1], orders: result[0].rows.slice(0, 2).map(ui.orderView), orderTotal: result[0].total, profile: profile || {}, totalTickets: profile ? profile.bucketDeliveryTickets + profile.bucketPickupTickets + profile.bagDeliveryTickets + profile.bagPickupTickets : 0 });
    if (staff) {
      const counts = await Promise.all(['PENDING','DISPATCHED'].map(status => api.call('orders', { status })));
      this.setData({ pending: counts[0].total, dispatched: counts[1].total, canMembers: api.can('member:read'), canOrder: api.can('order:create') });
    }
  }); },
  shop(e) { wx.navigateTo({ url: '/pages/shop/index?mode=' + (e.currentTarget.dataset.mode || 'DELIVERY') }); },
  orders() { wx.switchTab({ url: '/pages/orders/index' }); },
  wallet() { wx.switchTab({ url: '/pages/wallet/index' }); },
  members() { wx.navigateTo({ url: '/pages/members/index' }); }
});
