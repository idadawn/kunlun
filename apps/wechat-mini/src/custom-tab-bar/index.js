const api = require('../lib/api');
// Members and staff share the tab pages declared in app.json; each role sees its own four.
const TABS = {
  MEMBER: [{ page: 'home', text: '首页', icon: 'drop' }, { page: 'orders', text: '订单', icon: 'order' }, { page: 'wallet', text: '水票', icon: 'ticket' }, { page: 'profile', text: '我的', icon: 'user' }],
  STAFF: [{ page: 'home', text: '工作台', icon: 'grid' }, { page: 'orders', text: '水单', icon: 'order' }, { page: 'members', text: '会员', icon: 'team' }, { page: 'profile', text: '我的', icon: 'user' }]
};
Component({
  data: { selected: '', tabs: [] },
  lifetimes: { attached() { this.sync(); } },
  methods: {
    sync() {
      const user = api.session();
      const pages = getCurrentPages();
      const route = pages.length ? pages[pages.length - 1].route : '';
      this.setData({ selected: route, tabs: TABS[user && user.subjectType === 'STAFF' ? 'STAFF' : 'MEMBER'].map(t => Object.assign({ path: 'pages/' + t.page + '/index' }, t)) });
    },
    go(e) {
      const page = e.currentTarget.dataset.page;
      if (this.data.selected !== 'pages/' + page + '/index') wx.switchTab({ url: '/pages/' + page + '/index' });
    }
  }
});
