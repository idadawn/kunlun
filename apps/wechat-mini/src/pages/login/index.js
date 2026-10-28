const api = require('../../lib/api');
const ui = require('../../lib/ui');
Page({
  data: { type: 'MEMBER', account: '', password: '', demo: api.config.mode === 'demo', busy: false, error: '' },
  onLoad() {
    if (api.session()) ui.run(this, async () => { await api.call('me'); wx.switchTab({ url: '/pages/home/index' }); });
  },
  choose(e) { this.setData({ type: e.currentTarget.dataset.type, password: '', error: '' }); },
  input(e) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); },
  login() { ui.run(this, async () => {
    if (getApp().blocked) throw new Error('测试构建不能用于正式版本');
    if (!this.data.demo && (!this.data.account.trim() || !this.data.password)) throw new Error('请输入账号和密码');
    await api.login(this.data.type, this.data.account.trim(), this.data.password);
    this.setData({ password: '' }); wx.switchTab({ url: '/pages/home/index' });
  }); }
});
