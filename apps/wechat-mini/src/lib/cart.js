// Takeout-style ordering maths shared by the member menu, staff counter orders and checkout.
// Pure functions only (no wx calls) so the rules stay testable in Node.
const BAG = 'BAG_7_5L';
const IMAGE = { BUCKET_18_9L: '/assets/water/bucket.svg', BAG_7_5L: '/assets/water/bag.svg' };
const SLOT_HOURS = [8, 10, 12, 14, 16, 18];
const MAX_QTY = 99;
const drafts = {};

const unitOf = water => (water === BAG ? '袋' : '桶');
const containerOf = water => (water === BAG ? 'BAG' : 'BUCKET');
const imageOf = water => IMAGE[water] || IMAGE.BUCKET_18_9L;
const modeText = mode => (mode === 'PICKUP' ? '自提' : '配送');
const fen = yuan => Math.round(Number(yuan || 0) * 100);
const money = cents => (cents / 100).toFixed(2);
// Menu prices read ¥5 rather than ¥5.00.
const price = cents => (cents % 100 ? money(cents) : String(cents / 100));

function ticketsFor(profile, water, mode) {
  return Number(profile && profile[(water === BAG ? 'bag' : 'bucket') + (mode === 'PICKUP' ? 'Pickup' : 'Delivery') + 'Tickets']) || 0;
}

/** The order being put together for one member; it survives moving between menu, address book and checkout. */
function draft(memberId) {
  if (!drafts[memberId]) drafts[memberId] = { mode: 'DELIVERY', cart: {}, addressId: '', slot: 0, remark: '' };
  return drafts[memberId];
}

/** Forget every draft, e.g. when the account changes. */
function reset() { Object.keys(drafts).forEach(k => { delete drafts[k]; }); }

/**
 * One menu row per product. Tickets of the chosen mode are used first; with `retail`, a product that has a
 * retail price can still be bought beyond the member's tickets, otherwise tickets cap the quantity.
 */
function menu(products, profile, d, retail) {
  return (products || []).map(p => {
    const unit = unitOf(p.waterType);
    const tickets = ticketsFor(profile, p.waterType, d.mode);
    const priceFen = retail && Number(p.retailPrice) > 0 ? fen(p.retailPrice) : 0;
    const min = d.mode === 'DELIVERY' ? Math.max(1, Number(p.deliveryMinimum) || 1) : 1;
    const max = priceFen ? MAX_QTY : Math.min(MAX_QTY, tickets);
    const qty = d.cart[p.waterType] || 0;
    return {
      waterType: p.waterType, name: p.name, packaging: p.packaging, unit, image: imageOf(p.waterType),
      minTag: min > 1 ? min + unit + '起送' : '', tickets, priceFen, priceText: priceFen ? price(priceFen) : '',
      min, max, qty, soldOut: !qty && max < min, full: qty >= max
    };
  });
}

/** Next quantity for a +/- tap: the first tap adds the delivery minimum and going below it removes the item. */
function step(item, delta) {
  if (delta > 0) return item.qty >= item.max ? item.qty : Math.min(item.max, Math.max(item.qty + delta, item.min));
  const next = item.qty + delta;
  return next < item.min ? 0 : next;
}

function summary(items, mode) {
  const lines = items.filter(i => i.qty > 0).map(i => {
    const useTickets = Math.min(i.tickets, i.qty);
    const buyQty = i.qty - useTickets;
    return Object.assign({}, i, { useTickets, buyQty, amountFen: buyQty * i.priceFen, amountText: money(buyQty * i.priceFen) });
  });
  const used = {};
  lines.forEach(l => { if (l.useTickets) used[l.unit] = (used[l.unit] || 0) + l.useTickets; });
  const count = lines.reduce((sum, l) => sum + l.qty, 0);
  const amountFen = lines.reduce((sum, l) => sum + l.amountFen, 0);
  const below = mode === 'DELIVERY' ? lines.find(l => l.qty < l.min) : null;
  const lacking = lines.find(l => l.buyQty > 0 && !l.priceFen);
  const blocker = below ? below.name + ' ' + below.min + below.unit + '起送，还差 ' + (below.min - below.qty) + ' ' + below.unit
    : lacking ? lacking.name + modeText(mode) + '票不足，剩 ' + lacking.tickets + ' ' + lacking.unit : '';
  return {
    lines, count, amountFen, amountText: money(amountFen), blocker, ready: count > 0 && !blocker,
    shortTickets: !below && !!lacking, ticketText: Object.keys(used).map(u => used[u] + ' ' + u).join(' · ')
  };
}

/** Cart bar text. `canBuy` offers the ticket shop when tickets alone cannot cover the cart. */
function bar(s, canBuy) {
  if (!s.count) return { empty: true, count: 0, headline: '未选购商品', note: '', action: '去结算', ready: false };
  const buy = s.shortTickets && canBuy;
  return {
    empty: false, count: s.count, warn: !!s.blocker, action: buy ? '买水票' : '去结算', ready: s.ready || buy,
    headline: s.amountFen ? '¥' + s.amountText : '水票支付',
    note: s.blocker || (s.ticketText ? '水票抵扣 ' + s.ticketText : '')
  };
}

/** The shortfall bought at retail price before the orders are placed. */
function retailLines(s, mode) {
  return s.lines.filter(l => l.buyQty > 0).map(l => ({ waterType: l.waterType, fulfillMode: mode, qty: l.buyQty }));
}

/** Per container: held, covered by paid deposit (less pending damage) and the unit deposit in fen. */
function positions(rows, configs) {
  const result = {};
  ['BUCKET', 'BAG'].forEach(type => {
    const row = (rows || []).find(r => r.containerType === type) || {};
    const config = (configs || []).find(c => c.containerType === type) || {};
    result[type] = { held: row.heldQty || 0, covered: (row.paidQty || 0) - (row.pendingDamageQty || 0), unitFen: fen(config.unitDeposit) };
  });
  return result;
}

/** Containers that still need a deposit after `fullOut` go out and `emptyIn` come back (the server's formula). */
function depositGap(position, fullOut, emptyIn) {
  return Math.max(0, position.held + fullOut - emptyIn - position.covered);
}

/** Deposit to settle on hand-over, assuming every empty the member holds is swapped back. */
function depositDue(lines, pos) {
  if (!pos) return { fen: 0, text: '' };
  let total = 0; const parts = [];
  lines.forEach(l => {
    const p = pos[containerOf(l.waterType)];
    const gap = depositGap(p, l.qty, Math.min(p.held, l.qty));
    if (gap) { total += gap * p.unitFen; parts.push(gap + ' 个' + l.unit); }
  });
  return { fen: total, amountText: money(total), text: parts.join('、') };
}

/** The address chosen for this order, else the default one, else the first. */
function pickAddress(addresses, id) {
  const list = addresses || [];
  return list.find(a => a.id === id) || list.find(a => a.isDefault) || list[0] || null;
}

/** Delivery windows in station time (UTC+8); a window stays bookable until an hour before it ends. */
function slots(now) {
  const t = new Date((now === undefined ? Date.now() : now) + 8 * 3600 * 1000);
  const hour = t.getUTCHours() + t.getUTCMinutes() / 60;
  const pad = n => (n < 10 ? '0' : '') + n;
  const label = (day, h) => day + ' ' + pad(h) + ':00–' + pad(h + 2) + ':00';
  return ['尽快送达'].concat(SLOT_HOURS.filter(h => h + 1 > hour).map(h => label('今天', h)), SLOT_HOURS.map(h => label('明天', h)));
}

module.exports = { draft, reset, menu, step, summary, bar, retailLines, positions, depositGap, depositDue, pickAddress, slots, ticketsFor, unitOf, containerOf, imageOf, modeText, money };
