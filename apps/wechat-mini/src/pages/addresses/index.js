const api = require('../../lib/api'); const ui = require('../../lib/ui'); const cart = require('../../lib/cart');
const blank = { id: '', contactName: '', contactPhone: '', location: '', doorNo: '', isDefault: false };
Page({
  data: { addresses: [], memberId: '', select: false, selectedId: '', editing: false, form: blank, error: '', busy: false },
  onLoad(options) {
    // `select` comes from ordering: tapping an address uses it for this order and goes back.
    this.setData({ memberId: decodeURIComponent(options.memberId || ''), select: options.select === '1' });
    this.title();
  },
  onShow() { if (ui.guard(this)) { if (!this.data.staff) this.setData({ memberId: api.session().subjectId }); this.load(); } },
  title() { wx.setNavigationBarTitle({ title: this.data.editing ? (this.data.form.id ? '编辑地址' : '新增地址') : this.data.select ? '选择收货地址' : '收货地址' }); },
  load() { return ui.run(this, async () => {
    if (!this.data.memberId) throw new Error('请先选择会员');
    const list = await api.call('addresses', { memberId: this.data.memberId });
    const picked = cart.pickAddress(list, cart.draft(this.data.memberId).addressId);
    this.setData({ addresses: list.map(a => Object.assign({}, a, { phoneText: ui.maskPhone(a.contactPhone) })), selectedId: picked ? picked.id : '' });
  }); },
  tap(e) {
    if (!this.data.select) return this.edit(e);
    cart.draft(this.data.memberId).addressId = e.currentTarget.dataset.id;
    wx.navigateBack();
  },
  edit(e) {
    const address = this.data.addresses.find(a => a.id === e.currentTarget.dataset.id);
    // A member's own new address starts with their name and phone; it can be changed for someone else.
    const user = api.session();
    const fresh = Object.assign({}, blank, this.data.staff ? {} : { contactName: user.displayName || '', contactPhone: user.phone || '' }, { isDefault: !this.data.addresses.length });
    this.setData({ editing: true, error: '', form: address ? Object.assign({}, blank, address) : fresh });
    this.title();
  },
  input(e) { this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value }); },
  isDefault(e) { this.setData({ 'form.isDefault': e.detail.value }); },
  close() { this.setData({ editing: false, error: '' }); this.title(); },
  save() { ui.run(this, async () => {
    const form = this.data.form;
    if (!form.contactName.trim() || !/^1\d{10}$/.test(form.contactPhone) || !form.location.trim() || !form.doorNo.trim()) throw new Error('请填写完整的联系人、手机号和地址');
    const saved = await api.call('saveAddress', { id: form.id, memberId: this.data.memberId, contactName: form.contactName.trim(), contactPhone: form.contactPhone, location: form.location.trim(), doorNo: form.doorNo.trim(), isDefault: form.isDefault });
    if (this.data.select && !form.id && saved && saved.id) {
      cart.draft(this.data.memberId).addressId = saved.id;
      wx.navigateBack(); return;
    }
    this.setData({ editing: false }); this.title();
    await this.load();
  }); }
});
