import type { ContainerType, FulfillMode, MemberProfile, OrderStatus, PayMethod, WaterOrder, WaterType } from './types';

export const money = (value: number | string) => Number(value).toFixed(2);
export const unitOf = (water: WaterType) => (water === 'BAG_7_5L' ? '袋' : '桶');
export const modeLabel = (mode: FulfillMode) => (mode === 'PICKUP' ? '自提' : '配送');
export const waterFallbackLabel = (water: WaterType) => (water === 'BAG_7_5L' ? '袋装水' : '桶装水');
export const containerLabel = (type: ContainerType) => (type === 'BUCKET' ? '15L 周转桶' : '5L 周转水袋');
/** Every water product travels in its own reusable container: buckets for bucket water, bags for bag water. */
export const containerOf = (water: WaterType): ContainerType => (water === 'BAG_7_5L' ? 'BAG' : 'BUCKET');

/** Available (unreserved) tickets of one product and fulfilment mode. */
export function ticketsFor(member: Pick<MemberProfile, 'bucketDeliveryTickets' | 'bucketPickupTickets' | 'bagDeliveryTickets' | 'bagPickupTickets'>, water: WaterType, mode: FulfillMode) {
  if (water === 'BAG_7_5L') return mode === 'DELIVERY' ? member.bagDeliveryTickets : member.bagPickupTickets;
  return mode === 'DELIVERY' ? member.bucketDeliveryTickets : member.bucketPickupTickets;
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
export function withinDate(time: string, filter: DateFilter): boolean {
  if (filter === 'ALL') return true;
  const day = stationDay();
  let start = new Date(`${filter === 'MONTH' ? day.slice(0, 8) + '01' : day}T00:00:00+08:00`);
  if (filter === 'WEEK') start = new Date(start.getTime() - 6 * 86400000);
  return new Date(time) >= start;
}

/** Joins 收货地址 and 门牌号 exactly as the server stores the display text. */
export const fullAddress = (location: string, doorNo: string) => [location.trim(), doorNo.trim()].filter(Boolean).join(' ');

export const PHONE_PATTERN = '1[0-9]{10}';
export const isMobilePhone = (value: string) => /^1\d{10}$/.test(value.trim());
