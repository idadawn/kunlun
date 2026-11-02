import { useState } from 'react';
import { filterPlans, modeLabel, money, planCategories, unitOf, type RechargePlan, type WaterProduct } from '@kunlun/shared';

/** Active packages as cards, narrowed by water and mode when there are several; one tap chooses. */
export function PlanChooser({ labelledBy, plans, products, value, onChange }: {
  labelledBy: string;
  plans: RechargePlan[];
  products: WaterProduct[];
  value: RechargePlan | null;
  onChange: (plan: RechargePlan) => void;
}) {
  const [category, setCategory] = useState('ALL');
  const active = filterPlans(plans);
  // Only water and mode combinations that have packages to choose from.
  const categories = planCategories(products).filter(c => c.id === 'ALL' || filterPlans(active, c.id).length);
  const order = (p: RechargePlan) => categories.findIndex(c => c.id === `${p.waterType}:${p.fulfillMode}`);
  const shown = category === 'ALL' ? [...active].sort((a, b) => order(a) - order(b) || a.price - b.price || a.buyQty - b.buyQty) : filterPlans(active, category);
  const water = (p: RechargePlan) => products.find(x => x.waterType === p.waterType)?.name ?? '水票';
  return <>
    {categories.length > 2 && (
      <div className="slot-chips" role="group" aria-label="套餐分类">
        {categories.map(c => (
          <button key={c.id} type="button" className={category === c.id ? 'active' : ''} aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>{c.id === 'ALL' ? '全部' : c.label}</button>
        ))}
      </div>
    )}
    <div className="charge-plans" role="group" aria-labelledby={labelledBy}>
      {shown.map(p => (
        <button key={p.id} type="button" className="charge-plan" aria-pressed={value?.id === p.id} title={p.name} onClick={() => onChange(p)}>
          <small>{water(p)} · {modeLabel(p.fulfillMode)}</small>
          <strong>¥{money(p.price)}</strong>
          <b>{p.buyQty}<small>{unitOf(p.waterType)}</small></b>
        </button>
      ))}
    </div>
  </>;
}
