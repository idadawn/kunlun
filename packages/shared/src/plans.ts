import type { FulfillMode, RechargePlan, WaterProduct } from './types';

const MODES: ReadonlyArray<[FulfillMode, string]> = [['PICKUP', '自提'], ['DELIVERY', '配送']];

/** 全部套餐, then every product's 自提 packages, then every product's 配送 packages; ids are `${waterType}:${mode}`. */
export function planCategories(products: ReadonlyArray<Pick<WaterProduct, 'waterType' | 'name'>>) {
  return [{ id: 'ALL', label: '全部套餐' }, ...MODES.flatMap(([mode, label]) => products.map(p => ({ id: `${p.waterType}:${mode}`, label: `${p.name} · ${label}` })))];
}

/** Only active packages can be chosen; results are ordered by price, then quantity. */
export function filterPlans<T extends Pick<RechargePlan, 'name' | 'price' | 'buyQty' | 'waterType' | 'fulfillMode' | 'status'>>(plans: T[], category = 'ALL', query = ''): T[] {
  const q = query.trim().toLowerCase();
  return plans
    .filter(p => p.status === 'ACTIVE' && (category === 'ALL' || `${p.waterType}:${p.fulfillMode}` === category) && (!q || `${p.name} ${p.price} ${p.buyQty}`.toLowerCase().includes(q)))
    .sort((a, b) => a.price - b.price || a.buyQty - b.buyQty || a.name.localeCompare(b.name));
}
