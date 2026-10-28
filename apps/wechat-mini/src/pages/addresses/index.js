const api = require('../../lib/api'); const ui = require('../../lib/ui');
Page({
  data: { addresses: [], memberId: '', editing: false, form: { id: '', contactName: '', contactPhone: '', location: '', doorNo: '', isDefault: false }, error: '', busy: false },
  onLoad(options) { this.setData({ memberId: options.memberId || '' }); },
  onShow() { if (ui.guard(this)) { if (!this.data.staff) this.setData({ memberId: api.session().subjectId }); this.load(); } },
  load() { return ui.run(this, async () => { if (!this.data.memberId) throw new Error('请先选择会员'); this.setData({ addresses: await api.call('addresses', { memberId: this.data.memberId }) }); }); },
  edit(e) { const address = this.data.addresses.find(a => a.id === e.currentTarget.dataset.id); this.setData({ editing: true, form: address ? Object.assign({}, address) : { id: '', contactName: '', contactPhone: '', location: '', doorNo: '', isDefault: !this.data.addresses.length } }); },
  input(e) { this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value }); },
  isDefault(e) { this.setData({ 'form.isDefault': e.detail.value }); },
  close() { this.setData({ editing: false }); },
  save() { ui.run(this, async () => {
    const form = this.data.form;
    if (!form.contactName.trim() || !/^1\d{10}$/.test(form.contactPhone) || !form.location.trim() || !form.doorNo.trim()) throw new Error('请填写完整的联系人、手机号和收货地址');
    await api.call('saveAddress', Object.assign({}, form, { memberId: this.data.memberId }));
    this.setData({ editing: false, addresses: await api.call('addresses', { memberId: this.data.memberId }) });
  }); }
});
