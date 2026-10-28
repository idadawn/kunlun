const api = require('../../lib/api'); const ui = require('../../lib/ui'); const menu = require('../../lib/menu');
// Staff counter: the member menu, ordered on a member's behalf with that member's tickets.
Page(Object.assign({}, menu, {
  data: { items: [], bar: {}, mode: 'DELIVERY', profile: {}, initial: '', busy: false, error: '' },
  onLoad(options) { this.memberId = decodeURIComponent(options.memberId || ''); },
  onShow() { if (ui.guard(this, 'STAFF')) this.load(); },
  load() { return ui.run(this, async () => {
    if (!this.memberId) throw new Error('请从会员列表选择会员');
    if (!api.can('order:create')) throw new Error('当前账号无代客下单权限');
    const [products, profile] = await Promise.all([api.call('products'), api.call('profile', { memberId: this.memberId })]);
    Object.assign(this, { products, profile, retail: false, canBuy: false });
    this.setData({ profile, initial: (profile.name || '会')[0] });
    this.renderMenu();
  }); },
  back() { wx.navigateBack(); }
}));
