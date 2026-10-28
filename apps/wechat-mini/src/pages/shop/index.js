const api = require('../../lib/api'); const ui = require('../../lib/ui');
Page({
  data: { products: [], selected: {}, quantity: 1, mode: 'DELIVERY', addresses: [], addressIndex: 0, remark: '', busy: false, error: '', memberId: '', memberName: '' },
  onLoad(options) { this.setData({ mode: options.mode === 'PICKUP' ? 'PICKUP' : 'DELIVERY', memberId: options.memberId || '', memberName: options.name || '' }); },
  onShow() { if (ui.guard(this)) this.load(); },
  load() { return ui.run(this, async () => {
    const user = api.session();
    const memberId = user.subjectType === 'MEMBER' ? user.subjectId : this.data.memberId;
    if (!memberId) throw new Error('请从会员服务中选择要订水的会员');
    if (user.subjectType === 'STAFF' && !api.can('order:create')) throw new Error('当前账号无代客订水权限');
    const [products, addresses, profile] = await Promise.all([api.call('products'), api.call('addresses', { memberId }), api.call('profile', { memberId })]);
    const selected = products.find(p => p.waterType === this.data.selected.waterType) || products[0];
    this.setData({ products, selected, addresses, memberId, profile, memberName: profile.name, addressIndex: Math.max(0, addresses.findIndex(a => a.isDefault)) }); this.balance();
  }); },
  balance() {
    const water = this.data.selected.waterType === 'BAG_7_5L' ? 'bag' : 'bucket';
    const col = water + (this.data.mode === 'DELIVERY' ? 'Delivery' : 'Pickup') + 'Tickets';
    this.setData({ available: (this.data.profile && this.data.profile[col]) || 0 });
  },
  select(e) { this.setData({ selected: this.data.products.find(p => p.waterType === e.currentTarget.dataset.water) }); this.balance(); this.requestKey = null; },
  mode(e) { this.setData({ mode: e.currentTarget.dataset.mode }); this.balance(); this.requestKey = null; },
  quantity(e) { this.setData({ quantity: Math.min(99, Math.max(1, this.data.quantity + Number(e.currentTarget.dataset.delta))) }); this.requestKey = null; },
  address(e) { this.setData({ addressIndex: Number(e.detail.value) }); this.requestKey = null; },
  remark(e) { this.setData({ remark: e.detail.value }); this.requestKey = null; },
  addresses() { wx.navigateTo({ url: '/pages/addresses/index?memberId=' + this.data.memberId }); },
  submit() { ui.run(this, async () => {
    const d = this.data; if (!d.selected.waterType) throw new Error('请选择水品');
    if (d.quantity > d.available) throw new Error('对应水票不足，请先购买水票');
    if (d.mode === 'DELIVERY' && d.quantity < d.selected.deliveryMinimum) throw new Error('该水品 ' + d.selected.deliveryMinimum + ' 份起送');
    if (d.mode === 'DELIVERY' && !d.addresses[d.addressIndex]) throw new Error('请先添加收货地址');
    if (!this.requestKey) this.requestKey = api.key();
    await api.call('createOrder', { memberId: d.memberId, waterType: d.selected.waterType, fulfillMode: d.mode, orderQty: d.quantity, addressId: d.mode === 'DELIVERY' ? d.addresses[d.addressIndex].id : null, remark: d.remark, idempotencyKey: this.requestKey });
    this.requestKey = null; wx.showToast({ title: '订水成功', icon: 'success' }); wx.switchTab({ url: '/pages/orders/index' });
  }); }
});
