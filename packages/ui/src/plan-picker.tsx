import { useEffect, useState } from 'react';
import { PLAN_CATEGORIES, filterPlans, modeLabel, money, unitOf, type RechargePlan, type WaterProduct } from '@kunlun/shared';
import { useApi } from './auth';
import { Dialog, useDialogs } from './feedback';
import { Icon } from './icons';

/** Category-first package chooser. Only active packages can be confirmed, and the choice is re-validated on confirm. */
export function PlanPickerDialog({ selectedId, onClose }: { selectedId?: string | null; onClose: (plan?: RechargePlan) => void }) {
  const api = useApi();
  const [plans, setPlans] = useState<RechargePlan[] | null>(null);
  const [products, setProducts] = useState<WaterProduct[]>([]);
  const [category, setCategory] = useState('ALL');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<RechargePlan | null>(null);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([api.listPlans(), api.listProducts()]).then(([p, water]) => {
      if (!alive) return;
      setPlans(p); setProducts(water);
      setSelected(filterPlans(p).find(x => x.id === selectedId) ?? null);
    }).catch(e => alive && setError(e.message));
    return () => { alive = false; };
  }, [api, selectedId]);

  const active = filterPlans(plans ?? []);
  const results = filterPlans(plans ?? [], category, query);

  const confirm = async () => {
    if (!selected || confirming) return;
    setConfirming(true); setError('');
    try {
      const current = await api.listPlans();
      const fresh = current.find(p => p.id === selected.id && p.status === 'ACTIVE');
      if (!fresh) { setPlans(current); setSelected(null); setError('该套餐已停用，请重新选择'); return; }
      onClose(fresh);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setConfirming(false); }
  };

  return (
    <Dialog title="选择充值套餐" description="仅显示启用中的套餐，先选择分类再确认。" className="plan-picker-dialog" onClose={() => onClose()}>
      <div className="picker-search"><Icon name="search" /><input type="search" aria-label="搜索启用套餐" placeholder="搜索套餐名称、金额或数量" value={query} onChange={e => setQuery(e.target.value)} /></div>
      <div className="picker-layout">
        <nav className="picker-categories" aria-label="套餐分类">
          {PLAN_CATEGORIES.map(c => (
            <button key={c.id} type="button" aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>{c.label}<span>{filterPlans(active, c.id).length}</span></button>
          ))}
        </nav>
        <div className="picker-results" role="group" aria-label="启用套餐列表">
          {plans === null ? <p>{error ? '套餐加载失败，请关闭后重试' : '正在加载套餐…'}</p> : <>
            <div className="picker-result-count">{results.length} 个可选套餐</div>
            <div className="picker-card-grid">
              {results.length ? results.map(p => (
                <button key={p.id} type="button" className="picker-plan-card" aria-pressed={p.id === selected?.id} onClick={() => { setSelected(p); setError(''); }}>
                  <span className="picker-card-top"><b>{products.find(x => x.waterType === p.waterType)?.name || '水票套餐'}</b><span>{p.fulfillMode === 'PICKUP' ? '门店自提' : '上门配送'}</span></span>
                  <span className="picker-card-value"><strong>¥{money(p.price)}</strong><b>{p.buyQty + p.giftQty}<small>{unitOf(p.waterType)}</small></b></span>
                  <span className="picker-card-name">{p.name}</span>
                </button>
              )) : <p className="picker-empty">没有符合条件的启用套餐</p>}
            </div>
          </>}
        </div>
      </div>
      <p className="account-error" role="alert">{error}</p>
      <footer>
        <span className="picker-selection">{selected ? `已选择：${selected.name}` : '尚未选择套餐'}</span>
        <button type="button" className="btn" onClick={() => onClose()}>取消</button>
        <button type="button" className="btn primary" disabled={!selected || confirming} onClick={confirm}>{confirming ? '正在确认…' : '确认选择'}</button>
      </footer>
    </Dialog>
  );
}

/** Button that shows the chosen package and opens the picker. */
export function PlanSelector({ id, plan, onChange }: { id: string; plan: RechargePlan | null; onChange: (plan: RechargePlan) => void }) {
  const dialogs = useDialogs();
  const [busy, setBusy] = useState(false);
  const unavailable = !!plan && plan.status !== 'ACTIVE';
  const open = async () => {
    setBusy(true);
    try {
      const chosen = await dialogs.open<RechargePlan>(close => <PlanPickerDialog selectedId={plan?.id} onClose={close} />);
      if (chosen) onChange(chosen);
    } finally { setBusy(false); }
  };
  return (
    <button type="button" id={id} className={`plan-selector-button${unavailable ? ' is-unavailable' : ''}`} aria-haspopup="dialog" aria-label="选择充值套餐" disabled={busy} onClick={open}>
      {plan ? <>
        <span className="plan-selector-icon"><Icon name={plan.fulfillMode === 'PICKUP' ? 'store' : 'truck'} /></span>
        <span className="plan-selector-text"><b>{plan.name}</b><small>¥{money(plan.price)} · {modeLabel(plan.fulfillMode)} · 到账 {plan.buyQty + plan.giftQty}{unitOf(plan.waterType)}{unavailable ? ' · 原套餐已停用，请重新选择' : ''}</small></span>
        <span className="plan-selector-change">更换</span>
      </> : <>
        <span className="plan-selector-icon"><Icon name="wallet" /></span>
        <span className="plan-selector-text"><b>选择充值套餐</b><small>按分类查看启用套餐</small></span>
        <Icon name="chevron" />
      </>}
    </button>
  );
}
