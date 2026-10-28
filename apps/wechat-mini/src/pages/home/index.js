const api = require('../../lib/api'); const ui = require('../../lib/ui'); const cart = require('../../lib/cart');
const menu = require('../../lib/menu'); const brand = require('../../lib/brand');
Page(Object.assign({}, menu, {
  data: { brand, items: [], bar: {}, mode: 'DELIVERY', address: null, ongoing: null, freeDelivery: false, stats: {}, recent: [], busy: false, error: '' },
  onShow() { if (ui.guard(this)) this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  load() { return ui.run(this, async () => {
    await api.call('me');
    if (api.session().subjectType === 'STAFF') await this.loadStaff(); else await this.loadMember();
  }); },
  async loadMember() {
    const memberId = api.session().subjectId;
    const [products, profile, addresses, orders] = await Promise.all([api.call('products'), api.call('profile', { memberId }), api.call('addresses', { memberId }), api.call('orders', { memberId })]);
    Object.assign(this, { memberId, products, profile, retail: !!api.config.retail, canBuy: true });
    const address = cart.pickAddress(addresses, cart.draft(memberId).addressId);
    this.setData({
      address: address && Object.assign({}, address, { phoneText: ui.maskPhone(address.contactPhone) }),
      ongoing: orders.rows.map(ui.orderView).find(o => o.active) || null,
      freeDelivery: products.every(p => !Number(p.deliveryFee))
    });
    this.renderMenu();
  },
  async loadStaff() {
    const [pending, dispatched, all] = await Promise.all([api.call('orders', { status: 'PENDING' }), api.call('orders', { status: 'DISPATCHED' }), api.call('orders')]);
    const user = api.session();
    this.setData({
      initial: (user.displayName || '员')[0], roleText: ui.roleText(user.role),
      stats: { pending: pending.total, dispatched: dispatched.total, total: all.total },
      recent: all.rows.slice(0, 3).map(ui.orderView),
      canMembers: api.can('member:read') && api.can('order:create'), canFulfill: api.can('order:fulfill')
    });
  },
  chooseAddress() { wx.navigateTo({ url: '/pages/addresses/index?select=1&memberId=' + encodeURIComponent(this.memberId) }); },
  openOrders(e) { getApp().orderFilter = (e && e.currentTarget.dataset.status) || ''; wx.switchTab({ url: '/pages/orders/index' }); },
  openMembers() { wx.switchTab({ url: '/pages/members/index' }); },
  // Look up a pickup order by the member's code and go straight to hand-over.
  verify() {
    wx.showModal({ title: '核销取水码', editable: true, placeholderText: '输入会员出示的取水码', confirmText: '查找', confirmColor: '#0F766E', success: r => {
      const code = r.confirm && (r.content || '').trim();
      if (code) ui.run(this, async () => {
        const result = await api.call('orders', { pickupCode: code });
        const order = result.rows.map(ui.orderView).find(o => o.active && o.fulfillMode === 'PICKUP');
        if (!order) throw new Error('没有找到取水码 ' + code + ' 的待取水订单');
        Object.assign(getApp(), { fulfillmentOrder: order, pickupCode: code });
        wx.navigateTo({ url: '/pages/fulfill/index' });
      });
    } });
  }
}));
