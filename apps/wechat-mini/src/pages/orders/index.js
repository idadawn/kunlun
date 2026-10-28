const api = require('../../lib/api'); const ui = require('../../lib/ui');
Page({
  data: { orders: [], status: '', page: 1, total: 0, error: '', busy: false, pickupCode: '', filters: [{ value: '', text: '全部' }, { value: 'PENDING', text: '待处理' }, { value: 'DISPATCHED', text: '配送中' }, { value: 'COMPLETED', text: '已完成' }, { value: 'CANCELLED', text: '已取消' }] },
  onShow() { if (ui.guard(this)) this.load(false); },
  onPullDownRefresh() { this.load(false).finally(() => wx.stopPullDownRefresh()); },
  load(more) { return ui.run(this, async () => {
    const page = more === true ? this.data.page + 1 : 1;
    const result = await api.call('orders', { status: this.data.status, page, pickupCode: this.data.pickupCode.trim() });
    this.setData({ orders: more === true ? this.data.orders.concat(result.rows.map(ui.orderView)) : result.rows.map(ui.orderView), total: result.total, page, canAccept: api.can('order:accept'), canFulfill: api.can('order:fulfill') });
  }); },
  filter(e) { if (this.data.busy) return; this.setData({ status: e.currentTarget.dataset.value }); this.load(false); },
  code(e) { this.setData({ pickupCode: e.detail.value }); },
  search() { this.load(false); },
  more() { this.load(true); },
  cancel(e) { const id = e.currentTarget.dataset.id; wx.showModal({ title: '取消这笔订水？', content: '预占的水票会退回账户。', success: r => { if (r.confirm) ui.run(this, async () => { await api.call('cancelOrder', { id }); }).then(() => this.refreshKeepError()); } }); },
  accept(e) { ui.run(this, async () => { await api.call('acceptOrder', { id: e.currentTarget.dataset.id }); }).then(() => this.refreshKeepError()); },
  async refreshKeepError() { const error = this.data.error; await this.load(false); if (error) this.setData({ error }); },
  fulfill(e) { const order = this.data.orders.find(o => o.id === e.currentTarget.dataset.id); getApp().fulfillmentOrder = order; wx.navigateTo({ url: '/pages/fulfill/index' }); }
});
