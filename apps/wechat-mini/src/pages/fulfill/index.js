const api = require('../../lib/api'); const ui = require('../../lib/ui');
Page({
  data: { order: null, emptyInM: '0', pickupCode: '', busy: false, error: '' },
  onShow() { if (ui.guard(this, 'STAFF')) {
    if (!api.can('order:fulfill')) { this.setData({ error: '当前账号无核销权限' }); return; }
    const order = getApp().fulfillmentOrder;
    if (!order) { this.setData({ error: '请返回水单列表重新选择订单' }); return; }
    this.setData({ order });
  } },
  input(e) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); },
  submit() { ui.run(this, async () => {
    const order = this.data.order; if (!order) throw new Error('请重新选择水单');
    const emptyInM = Number(this.data.emptyInM);
    if (!Number.isInteger(emptyInM) || emptyInM < 0) throw new Error('请输入有效的空桶或空袋回收数量');
    if (order.fulfillMode === 'PICKUP' && !this.data.pickupCode.trim()) throw new Error('请向会员核对自提码');
    await api.call('fulfillOrder', { id: order.id, actualQty: order.orderQty, fullOutN: order.orderQty, emptyInM, pickupCode: this.data.pickupCode.trim() || null });
    getApp().fulfillmentOrder = null; wx.showToast({ title: '交付完成', icon: 'success' }); wx.navigateBack();
  }); }
});
