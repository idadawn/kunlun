import { useState } from 'react';
import { unitOf, type ActiveStatus, type CouponTemplate, type RechargePlan } from '@kunlun/shared';
import { Field, FormDialog, Icon, PlanSelector, useApi, useDialogs, useLoader, useToast } from '@kunlun/ui';
import { useOperations } from '../common';
import { useAdminData } from '../data';

type CouponState = 'LIVE' | 'SCHEDULED' | 'EXPIRED' | 'DISABLED';
const LABELS: Record<CouponState, string> = { LIVE: '生效中', SCHEDULED: '未开始', EXPIRED: '已过期', DISABLED: '已停用' };
const couponState = (c: CouponTemplate, now = new Date()): CouponState =>
  c.status !== 'ACTIVE' ? 'DISABLED' : new Date(c.expiresAt) <= now ? 'EXPIRED' : new Date(c.startsAt) > now ? 'SCHEDULED' : 'LIVE';
const shortDate = (v: string) => new Date(v).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
const localInput = (value: string | number) => { const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };

export function Coupons() {
  const { plans, version, refresh } = useAdminData();
  const api = useApi();
  const dialogs = useDialogs();
  const ops = useOperations();
  const templates = useLoader(() => api.listCouponTemplates(), [api, version]);
  const [filter, setFilter] = useState<CouponState | 'ALL'>('ALL');
  const [query, setQuery] = useState('');
  const rows = (templates.data ?? []).filter(c => (filter === 'ALL' || couponState(c) === filter)
    && `${c.name} ${plans.find(p => p.id === c.planId)?.name ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  const edit = (template?: CouponTemplate) => dialogs.open(close => <CouponDialog template={template} plans={plans} onClose={close} onDone={refresh} />);

  return <>
    <div className="page-head"><div><h2>优惠券</h2><p>配置充值赠水活动，向会员发放优惠券</p></div></div>
    <div id="couponsContent">
      <div className="coupon-toolbar">
        <div className="coupon-filters">
          <label htmlFor="couponFilter">活动状态</label>
          <select id="couponFilter" className="select" value={filter} onChange={e => setFilter(e.target.value as typeof filter)}>
            <option value="ALL">全部活动</option><option value="LIVE">生效中</option><option value="SCHEDULED">未开始</option><option value="EXPIRED">已过期</option><option value="DISABLED">已停用</option>
          </select>
          <input className="input" type="search" aria-label="搜索优惠券或套餐" placeholder="搜索优惠券或套餐" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
        <div className="membership-actions">
          <button type="button" className="btn" onClick={() => ops.issueCoupon()}>发放优惠券</button>
          <button type="button" className="btn primary" onClick={() => edit()}><Icon name="plus" />新建优惠券</button>
        </div>
      </div>
      {templates.error && <p className="account-error" role="alert">{templates.error}</p>}
      <div className="coupon-list-caption">{templates.data ? `共 ${rows.length} 个优惠券活动` : '正在加载…'}</div>
      <div className="coupon-grid">
        {templates.data && (rows.length ? rows.map(c => {
          const p = plans.find(x => x.id === c.planId);
          const state = couponState(c);
          const canIssue = c.status === 'ACTIVE' && new Date(c.expiresAt) > new Date() && p?.status === 'ACTIVE';
          return (
            <article key={c.id} className="coupon-card">
              <header>
                <div className="coupon-gift"><span>赠水券</span><strong>{c.giftQty}<small>{p ? unitOf(p.waterType) : '张'}</small></strong></div>
                <div className="coupon-title"><h3>{c.name}</h3><span className={`coupon-status state-${state.toLowerCase()}`}>{LABELS[state]}</span></div>
              </header>
              <div className="coupon-scope"><small>适用套餐{p?.status !== 'ACTIVE' ? ' · 套餐已停用' : ''}</small><b>{p?.name ?? '原套餐'}</b></div>
              <div className="coupon-facts"><span>每人限领 <b>{c.perMemberLimit}</b> 次</span><span>{shortDate(c.startsAt)} — {shortDate(c.expiresAt)}</span></div>
              <footer>
                <button type="button" className="btn sm" onClick={() => edit(c)}><Icon name="edit" size="sm" />编辑规则</button>
                <button type="button" className="btn primary sm" disabled={!canIssue} onClick={() => ops.issueCoupon(undefined, c.id)}>发放此券</button>
              </footer>
            </article>
          );
        }) : <div className="plan-empty">暂无符合条件的优惠券活动</div>)}
      </div>
    </div>
  </>;
}

function CouponDialog({ template, plans, onClose, onDone }: { template?: CouponTemplate; plans: RechargePlan[]; onClose: () => void; onDone: () => Promise<void> }) {
  const api = useApi();
  const toast = useToast();
  const [name, setName] = useState(template?.name ?? '');
  const [plan, setPlan] = useState<RechargePlan | null>(template ? plans.find(p => p.id === template.planId) ?? null : null);
  const [gift, setGift] = useState(String(template?.giftQty ?? 1));
  const [limit, setLimit] = useState(String(template?.perMemberLimit ?? 1));
  const [start, setStart] = useState(localInput(template?.startsAt ?? Date.now()));
  const [end, setEnd] = useState(localInput(template?.expiresAt ?? Date.now() + 30 * 86400000));
  const [status, setStatus] = useState<ActiveStatus>(template?.status ?? 'ACTIVE');
  const submit = async () => {
    if (!plan || plan.status !== 'ACTIVE') throw new Error('请选择已启用的充值套餐');
    await api.saveCouponTemplate(template?.id ?? null, { name, planId: plan.id, giftQty: Number(gift), startsAt: new Date(start).toISOString(), expiresAt: new Date(end).toISOString(), perMemberLimit: Number(limit), status });
    await onDone();
    toast('优惠券已保存');
  };
  return (
    <FormDialog title={template ? '修改赠水优惠券' : '新建赠水优惠券'} className="coupon-editor" onClose={onClose} onSubmit={submit}>
      <div className="coupon-form-grid">
        <div className="coupon-field coupon-wide"><Field label="优惠券名称" htmlFor="couponName"><input id="couponName" className="input" required maxLength={80} placeholder="例如：首次充值赠水券" value={name} onChange={e => setName(e.target.value)} /></Field></div>
        <div className="coupon-field coupon-wide"><Field label="适用充值套餐" htmlFor="couponPlanPicker"><PlanSelector id="couponPlanPicker" plan={plan} onChange={setPlan} /></Field></div>
        <div className="coupon-field"><Field label="赠送水票数量" htmlFor="couponGift"><input id="couponGift" className="input" type="number" required min={1} max={10000} step={1} value={gift} onChange={e => setGift(e.target.value)} /></Field></div>
        <div className="coupon-field"><Field label="每人最多领取次数" htmlFor="couponLimit"><input id="couponLimit" className="input" type="number" required min={1} max={1000} step={1} value={limit} onChange={e => setLimit(e.target.value)} /></Field></div>
        <div className="coupon-field"><Field label="开始时间" htmlFor="couponStart"><input id="couponStart" className="input" type="datetime-local" required value={start} onChange={e => setStart(e.target.value)} /></Field></div>
        <div className="coupon-field"><Field label="截止时间" htmlFor="couponEnd"><input id="couponEnd" className="input" type="datetime-local" required value={end} onChange={e => setEnd(e.target.value)} /></Field></div>
        <div className="coupon-field"><Field label="活动状态" htmlFor="couponStatus"><select id="couponStatus" className="select" value={status} onChange={e => setStatus(e.target.value as ActiveStatus)}><option value="ACTIVE">启用</option><option value="DISABLED">停用</option></select></Field></div>
      </div>
      <p className="membership-note">仅可选择启用套餐；已发放的优惠券保留原规则，修改用于后续发券。</p>
    </FormDialog>
  );
}
