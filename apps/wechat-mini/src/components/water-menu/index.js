// Product list with takeout-style steppers and the floating cart bar; the page owns the cart state.
Component({
  options: { addGlobalClass: true },
  properties: { items: { type: Array, value: [] }, bar: { type: Object, value: {} }, tabbar: { type: Boolean, value: false }, buy: { type: Boolean, value: true } },
  methods: {
    step(e) { this.triggerEvent('step', { water: e.currentTarget.dataset.water, delta: Number(e.currentTarget.dataset.delta) }); },
    tickets() { this.triggerEvent('tickets'); },
    checkout() { if (this.data.bar.ready) this.triggerEvent('checkout'); }
  }
});
