const api = require('./api');
const cart = require('./cart');
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
function stationTime(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ') : '';
}
function orderView(o) {
  const time = stationTime(o.createdAt);
  const pickup = o.fulfillMode === 'PICKUP';
  return Object.assign({}, o, {
    label: (o.productSnapshot && o.productSnapshot.waterLabel) || (o.waterType === 'BAG_7_5L' ? '袋装水' : '桶装水'),
    unit: cart.unitOf(o.waterType),
    image: cart.imageOf(o.waterType),
    statusText: { PENDING: pickup ? '待取水' : '待接单', DISPATCHED: '配送中', COMPLETED: '已完成', CANCELLED: '已取消' }[o.status],
    modeText: pickup ? '到店自提' : '送水上门',
    timeText: time || '时间待确认',
    shortTime: time ? time.slice(5) : '',
    active: o.status === 'PENDING' || o.status === 'DISPATCHED'
  });
}
const ROLES = { ADMIN: '站长', CLERK: '店员', COURIER: '送水员', MEMBER: '会员' };
function maskPhone(phone) { return /^1\d{10}$/.test(phone || '') ? phone.slice(0, 3) + '****' + phone.slice(7) : phone || ''; }
module.exports = { guard, run, error, money, orderView, maskPhone, roleText: role => ROLES[role] || '员工' };
