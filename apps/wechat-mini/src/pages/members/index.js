const api = require('../../lib/api'); const ui = require('../../lib/ui');
Page({
  data: { members: [], query: '', page: 1, total: 0, error: '', busy: false, canOrder: false },
  onShow() { if (ui.guard(this, 'STAFF')) this.search(); },
  input(e) { this.setData({ query: e.detail.value }); },
  search() { return this.load(false); },
  more() { return this.load(true); },
  load(more) { return ui.run(this, async () => {
    if (!api.can('member:read')) throw new Error('当前账号无会员查询权限');
    const page = more ? this.data.page + 1 : 1;
    const result = await api.call('members', { q: this.data.query.trim(), page });
    this.setData({ members: more ? this.data.members.concat(result.rows) : result.rows, total: result.total, page, canOrder: api.can('order:create') });
  }); },
  order(e) { const m = this.data.members.find(m => m.id === e.currentTarget.dataset.id); wx.navigateTo({ url: '/pages/shop/index?memberId=' + m.id + '&name=' + encodeURIComponent(m.name) }); }
});
