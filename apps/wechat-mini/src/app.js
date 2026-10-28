const api = require('./lib/api');
App({
  onLaunch() {
    const info = wx.getAccountInfoSync();
    this.blocked = info.miniProgram.envVersion === 'release';
    // This delivery is a test application, including when using a real test backend.
    if (this.blocked) wx.showModal({ title: '测试版本', content: '当前构建仅用于开发和体验测试，不能作为正式版使用。', showCancel: false });
  },
  api
});
