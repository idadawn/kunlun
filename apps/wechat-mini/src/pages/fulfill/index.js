const api = require('../../lib/api'); const ui = require('../../lib/ui'); const cart = require('../../lib/cart');
const PAY_METHODS = [{ value: 'CASH', label: '现金' }, { value: 'WECHAT', label: '微信' }, { value: 'ALIPAY', label: '支付宝' }];
Page({
  data: { order: null, held: 0, emptyIn: 0, gap: 0, depositText: '', pickupCode: '', payMethod: 'CASH', payMethods: PAY_METHODS, canCollect: false, busy: false, error: '' },
  onShow() {
    if (!ui.guard(this, 'STAFF')) return;
    if (!api.can('order:fulfill')) { this.setData({ error: '当前账号无交付权限' }); return; }
    const app = getApp(); const order = app.fulfillmentOrder;
    if (!order) { this.setData({ error: '请返回水单列表重新选择' }); return; }
    if (this.data.order && this.data.order.id === order.id) return;
    this.setData({ order, pickupCode: app.pickupCode || '', canCollect: api.can('deposit:collect') });
    app.pickupCode = '';
    ui.run(this, () => this.loadDeposit(true).catch(() => {}));
  },
  // Every empty the member holds is assumed to come back unless the courier records otherwise.
  async loadDeposit(reset) {
    const order = this.data.order;
    const result = await api.call('deposits', { memberId: order.memberId });
    this.position = cart.positions(result[0], result[1])[cart.containerOf(order.waterType)];
    if (reset) this.setData({ held: this.position.held, emptyIn: Math.min(this.position.held, order.orderQty) });
    this.recalc();
  },
  recalc() {
    if (!this.position) return;
    const gap = cart.depositGap(this.position, this.data.order.orderQty, this.data.emptyIn);
    this.setData({ gap, depositText: cart.money(gap * this.position.unitFen) });
  },
  step(e) { this.setData({ emptyIn: Math.min(9999, Math.max(0, this.data.emptyIn + Number(e.currentTarget.dataset.delta))) }); this.recalc(); },
  pay(e) { this.setData({ payMethod: e.currentTarget.dataset.value }); },
  input(e) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); },
  submit() { ui.run(this, async () => {
    const order = this.data.order; if (!order) throw new Error('请返回水单列表重新选择');
    if (order.fulfillMode === 'PICKUP' && !this.data.pickupCode.trim()) throw new Error('请输入会员出示的取水码');
    if (this.data.gap) {
      if (!this.data.canCollect) throw new Error('需补押金，当前账号不能收押金，请回门店办理');
      const body = { memberId: order.memberId, containerType: cart.containerOf(order.waterType), quantity: this.data.gap, payMethod: this.data.payMethod };
      if (!this.deposit || this.deposit.sig !== JSON.stringify(body)) this.deposit = { sig: JSON.stringify(body), key: api.key() };
      await api.call('collectDeposit', Object.assign({ idempotencyKey: this.deposit.key }, body));
      // Re-read coverage so a retry after a failed hand-over does not collect again.
      await this.loadDeposit(false);
    }
    await api.call('fulfillOrder', { id: order.id, actualQty: order.orderQty, fullOutN: order.orderQty, emptyInM: this.data.emptyIn, pickupCode: this.data.pickupCode.trim() || null });
    getApp().fulfillmentOrder = null; wx.showToast({ title: '交付完成', icon: 'success' });
    setTimeout(() => wx.navigateBack(), 600);
  }); }
});
