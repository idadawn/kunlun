const api = require('./api');
function error(page, e) { page.setData({ error: e.message || '操作失败，请重试', busy: false }); }
function guard(page, role) {
  if (getApp().blocked) return false;
  const user = api.session();
  if (!user) { wx.reLaunch({ url: '/pages/login/index' }); return false; }
  if (role && user.subjectType !== role) { wx.switchTab({ url: '/pages/home/index' }); return false; }
  page.setData({ user, staff: user.subjectType === 'STAFF', demo: api.config.mode === 'demo', error: '' });
  if (page.getTabBar && page.getTabBar()) page.getTabBar().sync();
  return true;
}
async function run(page, task) {
  if (page.data.busy) return;
  page.setData({ busy: true, error: '' });
  try { return await task(); } catch (e) { error(page, e); }
  finally { page.setData({ busy: false }); }
}
function money(cents) { return (cents / 100).toFixed(2); }
function orderView(o) {
  const timestamp = Date.parse(o.createdAt);
  const stationTime = Number.isFinite(timestamp) ? new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ') : '时间待确认';
  return Object.assign({}, o, {
    label: (o.productSnapshot && o.productSnapshot.waterLabel) || (o.waterType === 'BAG_7_5L' ? '袋装水' : '桶装水'),
    statusText: { PENDING: '待处理', DISPATCHED: '配送中', COMPLETED: '已完成', CANCELLED: '已取消' }[o.status],
    modeText: o.fulfillMode === 'DELIVERY' ? '送水上门' : '到店自提',
    timeText: stationTime
  });
}
module.exports = { guard, run, error, money, orderView };
