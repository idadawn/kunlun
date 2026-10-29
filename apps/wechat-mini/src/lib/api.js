const config = require('../config');
const SESSION = 'kunlun-mini-session-' + config.mode + '-' + config.apiBase;
let active = null;
let backend = null;
let connecting = null;
function session() { if (!active) active = wx.getStorageSync(SESSION) || null; return active; }
function setSession(value) { active = value; if (value) wx.setStorageSync(SESSION, value); else wx.removeStorageSync(SESSION); }
function request(path, method, data) {
  return new Promise((resolve, reject) => {
    const user = session();
    wx.request({ url: config.apiBase + path, method: method || 'GET', data, timeout: 15000, header: Object.assign({ 'Content-Type': 'application/json' }, user ? { Authorization: 'Bearer ' + user.accessToken } : {}),
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) { resolve(res.data); return; }
        if (res.statusCode === 401 && user) { setSession(null); wx.reLaunch({ url: '/pages/login/index' }); }
        const message = res.data && typeof res.data === 'object' && (res.data.message || res.data.error);
        const error = new Error(message || (res.statusCode === 403 ? '当前账号没有此操作权限' : res.statusCode === 429 ? '登录尝试过于频繁，请稍后再试' : '请求失败，请重试'));
        error.status = res.statusCode;
        reject(error);
      },
      fail() { reject(new Error('网络连接失败，请检查网络后重试')); }
    });
  });
}
// API builds fail closed: never replace an unavailable server with local fixtures.
async function connect(force) {
  if (config.mode === 'demo') return { environmentLabel: '本地演示', paymentProvider: 'MOCK', retailPaymentsEnabled: true };
  if (!force && backend) return backend;
  if (connecting) return connecting;
  connecting = request('/api/mini-config').then(value => {
    if (!value || value.service !== 'kunlun.waterstation' || value.apiVersion !== 1 || value.environment !== 'test'
      || !['MOCK', 'DISABLED'].includes(value.paymentProvider) || typeof value.retailPaymentsEnabled !== 'boolean') {
      throw new Error('测试服务配置不匹配，请联系管理员');
    }
    backend = value;
    config.retail = value.retailPaymentsEnabled;
    config.paymentMode = value.paymentProvider === 'MOCK' ? 'mock' : 'disabled';
    return value;
  }).finally(() => { connecting = null; });
  return connecting;
}
function query(data) { return Object.keys(data || {}).filter(k => data[k] !== undefined && data[k] !== '').map(k => encodeURIComponent(k) + '=' + encodeURIComponent(data[k])).join('&'); }
async function login(type, account, password) {
  if (!['STAFF', 'MEMBER'].includes(type)) throw new Error('登录身份无效');
  await connect(true);
  let value;
  if (config.mode === 'demo') value = require('./demo').login(type);
  else value = await request('/api/auth/' + (type === 'STAFF' ? 'staff' : 'member') + '/login', 'POST', { account, password });
  if (!value || value.subjectType !== type || !value.accessToken || !value.subjectId || !Array.isArray(value.permissions)) throw new Error('登录身份无效');
  setSession(value); return value;
}
async function logout() { if (config.mode !== 'demo') await request('/api/auth/logout', 'POST'); setSession(null); }
async function call(action, p) {
  p = p || {};
  if (config.mode === 'demo') return require('./demo').call(action, p, session());
  await connect();
  switch (action) {
    case 'me': { const me = await request('/api/auth/me'); setSession(Object.assign({}, session(), me)); return me; }
    case 'products': return request('/api/products');
    case 'plans': return request('/api/plans');
    case 'profile': return request('/api/members/' + p.memberId + '/profile');
    case 'addresses': return request('/api/members/' + p.memberId + '/addresses');
    case 'saveAddress': return request('/api/members/' + p.memberId + '/addresses' + (p.id ? '/' + p.id : ''), p.id ? 'PUT' : 'POST', p);
    case 'members': return request('/api/members?' + query(Object.assign({ page: 1, pageSize: 20 }, p)));
    case 'orders': return request('/api/orders?' + query(Object.assign({ page: 1, pageSize: 20 }, p)));
    case 'createOrder': return request('/api/orders', 'POST', p);
    case 'acceptOrder': return request('/api/orders/' + p.id + '/accept', 'POST');
    case 'cancelOrder': return request('/api/orders/' + p.id + '/cancel', 'POST', { cancelReason: '小程序取消预约' });
    case 'fulfillOrder': return request('/api/orders/' + p.id + '/fulfill', 'POST', p);
    case 'deposits': {
      const rows = await request('/api/members/' + p.memberId + '/deposit-summary');
      return [rows, rows.map(row => ({ containerType: row.containerType, unitDeposit: row.unitDeposit }))];
    }
    case 'collectDeposit': return request('/api/deposits/collect', 'POST', p);
    case 'createPayment':
      if (config.paymentMode === 'disabled') throw new Error('测试支付尚未启用，请联系管理员');
      return request('/api/mini-payments', 'POST', p);
    case 'payment': return request('/api/mini-payments/' + p.id);
    case 'payments': return config.paymentMode === 'disabled' ? [] : request('/api/mini-payments');
    case 'mockPay': return request('/api/mini-payments/' + p.id + '/simulate', 'POST', { outcome: p.outcome });
    default: throw new Error('未知操作');
  }
}
function can(action) { const u = session(); return !!u && u.permissions.includes('kunlun.waterstation:' + action); }
function key() { return 'mini-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14); }
module.exports = { config, session, login, logout, call, can, key, connect };
