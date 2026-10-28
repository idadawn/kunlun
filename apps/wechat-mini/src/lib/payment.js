const api = require('./api');
async function pay(order) {
  if (order.status === 'SUCCESS') return order;
  if (order.provider === 'MOCK') {
    const amount = '¥' + (order.amountFen / 100).toFixed(2);
    const result = await new Promise((resolve, reject) => wx.showActionSheet({ itemList: ['模拟支付 ' + amount + '（测试，不扣款）', '模拟用户取消', '模拟支付失败'], success: resolve, fail: () => reject(new Error('已取消支付')) }));
    const outcome = ['SUCCESS','CANCEL','FAIL'][result.tapIndex];
    await api.call('mockPay', { id: order.id, outcome });
    if (outcome !== 'SUCCESS') throw new Error(outcome === 'CANCEL' ? '已取消支付' : '支付失败，请重试');
  } else {
    // Official wx.requestPayment contract. The server alone signs these values.
    const p = order.paymentParameters;
    if (!p || p.signType !== 'RSA') throw new Error('支付参数尚未就绪，请稍后重试');
    await new Promise(resolve => wx.requestPayment({ timeStamp: p.timeStamp, nonceStr: p.nonceStr, package: p.package, signType: 'RSA', paySign: p.paySign, success: resolve, fail: resolve }));
  }
  // A client success callback never credits tickets. Read the authoritative result.
  const result = await api.call('payment', { id: order.id });
  if (result.status !== 'SUCCESS') throw new Error('支付结果确认中，请稍后在水票记录刷新；请勿重复购买');
  return result;
}
module.exports = { pay };
