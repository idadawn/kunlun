const api = require('../lib/api');
Component({
  data: { selected: '', tabs: [] },
  lifetimes: { attached() { this.sync(); } },
  methods: {
    sync() {
      const user = api.session();
      const staff = user && user.subjectType === 'STAFF';
      const pages = getCurrentPages();
      this.setData({ selected: pages.length ? pages[pages.length - 1].route : '', tabs: [
        { page: 'home', text: staff ? '工作台' : '首页' }, { page: 'orders', text: '水单' },
        { page: 'wallet', text: staff ? '业务' : '水票' }, { page: 'profile', text: '我的' }
      ] });
    },
    go(e) { wx.switchTab({ url: '/pages/' + e.currentTarget.dataset.page + '/index' }); }
  }
});
