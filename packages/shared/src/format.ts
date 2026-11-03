import type { ContainerType, FulfillMode, MemberProfile, MemberTicket, OrderStatus, PayMethod, WaterOrder, WaterProduct, WaterType } from './types';

// Name and container of every water product by code. Each app passes the product lists it loads to rememberProducts;
// the two original products are known before the first load.
const products = new Map<WaterType, Pick<WaterProduct, 'name' | 'containerType'>>([
  ['BUCKET_18_9L', { name: '桶装水', containerType: 'BUCKET' }],
  ['BAG_7_5L', { name: '袋装水', containerType: 'BAG' }],
]);
export function rememberProducts(list: ReadonlyArray<Pick<WaterProduct, 'waterType' | 'name' | 'containerType'>>) {
  for (const p of list) products.set(p.waterType, { name: p.name, containerType: p.containerType });
}

export const money = (value: number | string) => Number(value).toFixed(2);
export const containerUnit = (type: ContainerType) => (type === 'BAG' ? '袋' : '桶');
/** Every water product travels in one kind of reusable container, which carries the deposit. */
export const containerOf = (water: WaterType): ContainerType => products.get(water)?.containerType ?? 'BUCKET';
export const unitOf = (water: WaterType) => containerUnit(containerOf(water));
export const modeLabel = (mode: FulfillMode) => (mode === 'PICKUP' ? '自提' : '配送');
export const waterFallbackLabel = (water: WaterType) => products.get(water)?.name ?? '水';
// Every bucket water shares one pool of buckets and one deposit, every bag water one pool of bags.
export const containerLabel = (type: ContainerType) => (type === 'BUCKET' ? '周转桶' : '周转水袋');

/** Available (unreserved) tickets of one water product and fulfilment mode. */
export function ticketsFor(member: Pick<MemberProfile, 'tickets'>, water: WaterType, mode: FulfillMode) {
  return member.tickets.find(t => t.waterType === water && t.fulfillMode === mode)?.available ?? 0;
}

/** One water product's tickets with 自提 and 配送 side by side. */
export interface TicketGroup { waterType: WaterType; name: string; unit: string; pickup: number; delivery: number; reserved: number }

/** A member's balances grouped by water product, in the server's order (oldest product first). */
export function ticketGroups(tickets: ReadonlyArray<MemberTicket>): TicketGroup[] {
  const groups = new Map<WaterType, TicketGroup>();
  for (const t of tickets) {
    let g = groups.get(t.waterType);
    if (!g) groups.set(t.waterType, g = { waterType: t.waterType, name: t.name, unit: t.unit, pickup: 0, delivery: 0, reserved: 0 });
    if (t.fulfillMode === 'PICKUP') g.pickup = t.available; else g.delivery = t.available;
    g.reserved += t.reserved;
  }
  return [...groups.values()];
}

/** Usable tickets of every water carried in one kind of container. */
export const containerTickets = (tickets: ReadonlyArray<MemberTicket>, type: ContainerType) =>
  tickets.reduce((sum, t) => sum + (t.containerType === type ? t.available : 0), 0);

/** e.g. "15L 桶装水 自提 10 / 配送 8 桶；5L 袋装水 自提 6 / 配送 0 袋", or 暂无水票. */
export function ticketSummary(tickets: ReadonlyArray<MemberTicket>) {
  const groups = ticketGroups(tickets);
  return groups.length ? groups.map(g => `${g.name} 自提 ${g.pickup} / 配送 ${g.delivery} ${g.unit}`).join('；') : '暂无水票';
}

export const PAY_METHODS: ReadonlyArray<{ value: PayMethod; label: string }> = [
  { value: 'CASH', label: '现金' },
  { value: 'WECHAT', label: '微信收款码' },
  { value: 'ALIPAY', label: '支付宝收款码' },
  { value: 'BANK', label: '银行转账' },
];
export const payMethodLabel = (value: string) => PAY_METHODS.find(p => p.value === value)?.label ?? value;

export function orderStatusLabel(order: Pick<WaterOrder, 'status' | 'fulfillMode'>): string {
  const labels: Record<OrderStatus, string> = {
    PENDING: order.fulfillMode === 'PICKUP' ? '待自提' : '待接单',
    DISPATCHED: '配送中',
    COMPLETED: '已完成',
    CANCELLED: '已取消',
  };
  return labels[order.status] ?? order.status;
}

export const isActiveOrder = (order: Pick<WaterOrder, 'status'>) => order.status === 'PENDING' || order.status === 'DISPATCHED';

export const shortDateTime = (value: string) =>
  new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Today in the station's time zone, as YYYY-MM-DD. */
export const stationDay = (date: Date = new Date()) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

export type DateFilter = 'ALL' | 'TODAY' | 'WEEK' | 'MONTH';
/** Start of the window in the station's time zone as ISO 8601, for a list query's `from`; undefined for 全部时间. */
export function dateFilterFrom(filter: DateFilter, now: Date = new Date()): string | undefined {
  if (filter === 'ALL') return undefined;
  const day = stationDay(now);
  const start = new Date(`${filter === 'MONTH' ? day.slice(0, 8) + '01' : day}T00:00:00+08:00`);
  return new Date(filter === 'WEEK' ? start.getTime() - 6 * 86400000 : start.getTime()).toISOString();
}

/** Joins 收货地址 and 门牌号 exactly as the server stores the display text. */
export const fullAddress = (location: string, doorNo: string) => [location.trim(), doorNo.trim()].filter(Boolean).join(' ');

export const PHONE_PATTERN = '1[0-9]{10}';
export const isMobilePhone = (value: string) => /^1\d{10}$/.test(value.trim());
