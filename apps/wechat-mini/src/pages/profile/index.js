const api = require('../../lib/api'); const ui = require('../../lib/ui');
Page({
  data: { user: {}, busy: false, error: '', profile: {} },
  onShow() { if (ui.guard(this)) ui.run(this, async () => { await api.call('me'); if (!this.data.staff) this.setData({ profile: await api.call('profile', { memberId: api.session().subjectId }) }); }); },
  addresses() { wx.navigateTo({ url: '/pages/addresses/index' }); },
  wallet() { wx.switchTab({ url: '/pages/wallet/index' }); },
  logout() { ui.run(this, async () => { await api.logout(); getApp().fulfillmentOrder = null; wx.reLaunch({ url: '/pages/login/index' }); }); }
});
