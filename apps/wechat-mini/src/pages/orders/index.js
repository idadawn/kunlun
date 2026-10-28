const api = require('../../lib/api'); const ui = require('../../lib/ui'); const cart = require('../../lib/cart');
const FILTERS = [{ value: '', text: '全部' }, { value: 'PENDING', text: '待处理' }, { value: 'DISPATCHED', text: '配送中' }, { value: 'COMPLETED', text: '已完成' }, { value: 'CANCELLED', text: '已取消' }];
Page({
  data: { orders: [], status: '', page: 1, total: 0, error: '', busy: false, pickupCode: '', filters: FILTERS },
  onShow() {
    if (!ui.guard(this)) return;
    // Other pages ask for a filter before switching to this tab.
    const app = getApp();
    if (app.orderFilter !== undefined) { this.setData({ status: app.orderFilter, pickupCode: '' }); app.orderFilter = undefined; }
    wx.setNavigationBarTitle({ title: this.data.staff ? '水单' : '我的订单' });
    this.load(false);
  },
  onPullDownRefresh() { this.load(false).finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.orders.length < this.data.total) this.load(true); },
  load(more) { return ui.run(this, async () => {
    const page = more === true ? this.data.page + 1 : 1;
    const staff = this.data.staff;
    const query = { status: this.data.status, page, pickupCode: this.data.pickupCode.trim() };
    if (!staff) query.memberId = api.session().subjectId;
    const result = await api.call('orders', query);
    const can = { accept: api.can('order:accept'), fulfill: api.can('order:fulfill') };
    const rows = result.rows.map(ui.orderView).map(o => {
      const flags = staff
        ? { canAccept: can.accept && o.status === 'PENDING' && o.fulfillMode === 'DELIVERY', canFulfill: can.fulfill && o.active }
        : { canCancel: o.status === 'PENDING', canReorder: !o.active, showCode: !!o.pickupCode && o.status === 'PENDING' };
      return Object.assign(o, flags, { hasActions: flags.canAccept || flags.canFulfill || flags.canCancel || flags.canReorder });
    });
    this.setData({ orders: more === true ? this.data.orders.concat(rows) : rows, total: result.total, page });
  }); },
  filter(e) { if (this.data.busy) return; this.setData({ status: e.currentTarget.dataset.value }); this.load(false); },
  code(e) { this.setData({ pickupCode: e.detail.value }); },
  clearCode() { this.setData({ pickupCode: '' }); this.load(false); },
  search() { this.load(false); },
  more() { this.load(true); },
  cancel(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({ title: '取消这个订单？', content: '用掉的水票会退回。', confirmText: '取消订单', confirmColor: '#CF4436', cancelText: '再想想', success: r => {
      if (r.confirm) ui.run(this, async () => { await api.call('cancelOrder', { id }); wx.showToast({ title: '已取消', icon: 'success' }); }).then(() => this.refreshKeepError());
    } });
  },
  // Same water, same quantity and the same way of getting it, ready to check out from the menu.
  reorder(e) {
    const o = this.data.orders.find(x => x.id === e.currentTarget.dataset.id);
    const d = cart.draft(api.session().subjectId);
    d.mode = o.fulfillMode; d.cart = {}; d.cart[o.waterType] = o.orderQty;
    wx.switchTab({ url: '/pages/home/index' });
  },
  accept(e) { ui.run(this, async () => { await api.call('acceptOrder', { id: e.currentTarget.dataset.id }); }).then(() => this.refreshKeepError()); },
  async refreshKeepError() { const error = this.data.error; await this.load(false); if (error) this.setData({ error }); },
  fulfill(e) { getApp().fulfillmentOrder = this.data.orders.find(o => o.id === e.currentTarget.dataset.id); wx.navigateTo({ url: '/pages/fulfill/index' }); },
  call(e) { wx.makePhoneCall({ phoneNumber: e.currentTarget.dataset.phone, fail() {} }); },
  shop() { wx.switchTab({ url: '/pages/home/index' }); }
});
