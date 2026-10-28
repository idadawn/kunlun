const api = require('../../lib/api'); const ui = require('../../lib/ui');
Page({
  data: { members: [], query: '', page: 1, total: 0, error: '', busy: false, canOrder: false },
  onShow() { if (ui.guard(this, 'STAFF')) this.search(); },
  onPullDownRefresh() { this.load(false).finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.members.length < this.data.total) this.load(true); },
  input(e) {
    this.setData({ query: e.detail.value });
    clearTimeout(this.timer); this.timer = setTimeout(() => this.search(), 400);
  },
  search() { clearTimeout(this.timer); return this.load(false); },
  more() { return this.load(true); },
  load(more) { return ui.run(this, async () => {
    if (!api.can('member:read')) throw new Error('当前账号无会员查询权限');
    const page = more ? this.data.page + 1 : 1;
    const result = await api.call('members', { q: this.data.query.trim(), page });
    const rows = result.rows.map(m => Object.assign({}, m, { initial: (m.name || '会')[0] }));
    this.setData({ members: more ? this.data.members.concat(rows) : rows, total: result.total, page, canOrder: api.can('order:create') });
  }); },
  order(e) { wx.navigateTo({ url: '/pages/shop/index?memberId=' + encodeURIComponent(e.currentTarget.dataset.id) }); }
});
