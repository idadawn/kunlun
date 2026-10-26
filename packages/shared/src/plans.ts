import type { RechargePlan } from './types';

export const PLAN_CATEGORIES = [
  { id: 'ALL', label: '全部套餐' },
  { id: 'BAG_7_5L:PICKUP', label: '袋装自提' },
  { id: 'BUCKET_18_9L:PICKUP', label: '桶装自提' },
  { id: 'BAG_7_5L:DELIVERY', label: '袋装配送' },
  { id: 'BUCKET_18_9L:DELIVERY', label: '桶装配送' },
] as const;

/** Only active packages can be chosen; results are ordered by price, then quantity. */
export function filterPlans<T extends Pick<RechargePlan, 'name' | 'price' | 'buyQty' | 'waterType' | 'fulfillMode' | 'status'>>(plans: T[], category = 'ALL', query = ''): T[] {
  const q = query.trim().toLowerCase();
  return plans
    .filter(p => p.status === 'ACTIVE' && (category === 'ALL' || `${p.waterType}:${p.fulfillMode}` === category) && (!q || `${p.name} ${p.price} ${p.buyQty}`.toLowerCase().includes(q)))
    .sort((a, b) => a.price - b.price || a.buyQty - b.buyQty || a.name.localeCompare(b.name));
}
