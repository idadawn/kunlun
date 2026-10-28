const api = require('../../lib/api'); const ui = require('../../lib/ui'); const cart = require('../../lib/cart'); const brand = require('../../lib/brand');
Page({
  data: { brand, user: {}, profile: {}, initial: '', subline: '', tickets: 0, deposit: '0', canMembers: false, busy: false, error: '' },
  onShow() { if (ui.guard(this)) this.load(); },
  load() { return ui.run(this, async () => {
    const user = await api.call('me'); const staff = this.data.staff;
    this.setData({ user: api.session(), initial: (user.displayName || '我')[0], subline: staff ? ui.roleText(user.role) + ' · ' + user.codeOrNo : ui.maskPhone(user.phone) + ' · ' + user.codeOrNo, canMembers: api.can('member:read') });
    if (staff) return;
    const profile = await api.call('profile', { memberId: user.subjectId });
    const yuan = Number(profile.depositAmount) || 0;
    this.setData({ profile, tickets: profile.bucketDeliveryTickets + profile.bucketPickupTickets + profile.bagDeliveryTickets + profile.bagPickupTickets, deposit: yuan % 1 ? yuan.toFixed(2) : String(yuan) });
  }); },
  addresses() { wx.navigateTo({ url: '/pages/addresses/index' }); },
  wallet() { wx.switchTab({ url: '/pages/wallet/index' }); },
  orders() { getApp().orderFilter = ''; wx.switchTab({ url: '/pages/orders/index' }); },
  members() { wx.switchTab({ url: '/pages/members/index' }); },
  logout() {
    wx.showModal({ title: '退出登录？', confirmText: '退出', confirmColor: '#CF4436', success: r => {
      if (r.confirm) ui.run(this, async () => { await api.logout(); cart.reset(); getApp().fulfillmentOrder = null; wx.reLaunch({ url: '/pages/login/index' }); });
    } });
  }
});
