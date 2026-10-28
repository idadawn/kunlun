const cart = require('./cart');
// Menu behaviour shared by the member home and the staff counter page. The page sets
// memberId, products, profile, retail (sell beyond tickets) and canBuy (may open the ticket shop).
module.exports = {
  renderMenu() {
    const d = cart.draft(this.memberId);
    const items = cart.menu(this.products, this.profile, d, this.retail);
    this.setData({ mode: d.mode, items, bar: cart.bar(cart.summary(items, d.mode), this.canBuy) });
  },
  setMode(e) {
    if (!this.memberId) return;
    cart.draft(this.memberId).mode = e.currentTarget.dataset.mode;
    this.renderMenu();
  },
  onStep(e) {
    const item = this.data.items.find(i => i.waterType === e.detail.water);
    if (!item || item.soldOut) return;
    cart.draft(this.memberId).cart[item.waterType] = cart.step(item, e.detail.delta);
    this.renderMenu();
  },
  onCheckout() {
    if (this.data.bar.action === '买水票') return this.onTickets();
    wx.navigateTo({ url: '/pages/checkout/index?memberId=' + encodeURIComponent(this.memberId) });
  },
  onTickets() {
    if (this.canBuy) wx.switchTab({ url: '/pages/wallet/index' });
    else wx.showToast({ title: '水票不足，请会员先购买水票', icon: 'none' });
  }
};
