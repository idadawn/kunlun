import { useCallback, useEffect, useState } from 'react';
import {
  KUNLUN_PERMISSIONS as P, modeLabel, money, unitOf, waterFallbackLabel,
  type CouponTemplate, type MemberCoupon, type PayMethod, type RechargePlan, type TicketBatch,
} from '@kunlun/shared';
import { useApi, useAuth } from '../auth';
import { Dialog, Field, FormDialog, useDialogs, useRun, useToast } from '../feedback';
import { useIdempotencyKey } from '../hooks';
import { PlanSelector } from '../plan-picker';
import { MemberPicker, PayOptions, ReasonChips, UnavailableDialog, errorText, usePickedMember, type Done } from './common';

const couponFits = (c: MemberCoupon, plan: RechargePlan, now = new Date()) =>
  c.status === 'AVAILABLE' && c.snapshot.planId === plan.id && c.snapshot.price === plan.price && c.snapshot.fixedQty === plan.buyQty
  && c.snapshot.fulfillMode === plan.fulfillMode && c.snapshot.waterType === plan.waterType
  && new Date(c.snapshot.startsAt) <= now && new Date(c.snapshot.expiresAt) > now;

export function RechargeDialog({ memberId, onClose, onDone }: { memberId?: string; onClose: () => void; onDone?: Done }) {
  const { api, can } = useAuth();
  const toast = useToast();
  const key = useIdempotencyKey();
  const [hasPlans, setHasPlans] = useState<boolean | null>(null);
  const [member, setMember] = usePickedMember(memberId);
  const [plan, setPlan] = useState<RechargePlan | null>(null);
  const [coupons, setCoupons] = useState<MemberCoupon[]>([]);
  const [couponId, setCouponId] = useState('');
  const [pay, setPay] = useState<PayMethod>('CASH');
  const [loadError, setLoadError] = useState('');

  useEffect(() => { api.listPlans().then(p => setHasPlans(p.some(x => x.status === 'ACTIVE'))).catch(e => setLoadError(errorText(e))); }, [api]);
  const owner = member?.id;
  useEffect(() => {
    let alive = true;
    setCoupons([]); setCouponId('');
    if (!plan || !owner) return;
    api.memberCoupons(owner).then(list => alive && setCoupons(list.filter(c => couponFits(c, plan)))).catch(e => alive && toast(errorText(e)));
    return () => { alive = false; };
  }, [api, owner, plan, toast]);

  if (!can(P.RechargeCreate)) return <UnavailableDialog title="水费充值登记" message="当前账号没有充值权限" onClose={onClose} />;
  if (loadError) return <UnavailableDialog title="水费充值登记" message={loadError} onClose={onClose} />;
  if (hasPlans === false) return <UnavailableDialog title="水费充值登记" message="请先配置并启用充值套餐" onClose={onClose} />;

  const coupon = coupons.find(c => c.id === couponId);
  const gift = (plan?.giftQty ?? 0) + (coupon?.snapshot.giftQty ?? 0);
  const submit = async () => {
    if (!member) throw new Error('请选择会员');
    if (!plan) throw new Error('请选择启用中的充值套餐');
    const result = await api.createRecharge({ memberId: member.id, planId: plan.id, couponId: couponId || null, payMethod: pay, idempotencyKey: key });
    await onDone?.();
    toast(`充值成功：付费 ${result.buyQty} + 赠送 ${result.giftQty}，共 ${result.totalTickets} 张水票`);
  };
  return (
    <FormDialog title="水费充值登记" submitLabel="确认已收款并登记" onClose={onClose} onSubmit={submit}>
      <Field label="会员" htmlFor="chargeMember"><MemberPicker id="chargeMember" value={member} onChange={setMember} /></Field>
      <Field label="充值套餐" htmlFor="chargePlanPicker"><PlanSelector id="chargePlanPicker" plan={plan} onChange={setPlan} /></Field>
      <Field label="优惠券（每笔最多一张）" htmlFor="chargeCoupon">
        <select id="chargeCoupon" className="select" value={couponId} onChange={e => setCouponId(e.target.value)}>
          <option value="">不使用优惠券</option>
          {plan && coupons.map(c => <option key={c.id} value={c.id}>{c.snapshot.name} · 赠 {c.snapshot.giftQty}{unitOf(plan.waterType)}</option>)}
        </select>
      </Field>
      <div className="membership-summary">
        {plan ? `实收 ¥${money(plan.price)} · ${modeLabel(plan.fulfillMode)}付费 ${plan.buyQty}${unitOf(plan.waterType)} + 赠送 ${gift}${unitOf(plan.waterType)} = 共 ${plan.buyQty + gift}${unitOf(plan.waterType)}` : '请选择充值套餐'}
      </div>
      <Field label="实际收款方式" htmlFor="chargePay"><select id="chargePay" className="select" value={pay} onChange={e => setPay(e.target.value as PayMethod)}><PayOptions /></select></Field>
      <p className="membership-note">确认线下已收款后登记；押金另行办理。</p>
    </FormDialog>
  );
}

export function IssueCouponDialog({ memberId, templateId, onClose, onDone }: { memberId?: string; templateId?: string; onClose: () => void; onDone?: Done }) {
  const api = useApi();
  const toast = useToast();
  const key = useIdempotencyKey();
  const [templates, setTemplates] = useState<CouponTemplate[] | null>(null);
  const [error, setError] = useState('');
  const [member, setMember] = usePickedMember(memberId);
  const [template, setTemplate] = useState('');

  useEffect(() => {
    Promise.all([api.listPlans(), api.listCouponTemplates()]).then(([plans, all]) => {
      const active = new Set(plans.filter(p => p.status === 'ACTIVE').map(p => p.id));
      const usable = all.filter(c => c.status === 'ACTIVE' && new Date(c.expiresAt) > new Date() && active.has(c.planId));
      setTemplates(usable);
      setTemplate(usable.some(c => c.id === templateId) ? templateId! : usable[0]?.id ?? '');
    }).catch(e => setError(errorText(e)));
  }, [api, templateId]);

  if (error) return <UnavailableDialog title="发放充值赠水券" message={error} onClose={onClose} />;
  if (!templates) return <Dialog title="发放充值赠水券" onClose={onClose}><p className="membership-note">正在加载优惠券…</p></Dialog>;
  if (!templates.length) return <UnavailableDialog title="发放充值赠水券" message="暂无可发放优惠券，请先在优惠券页面创建" onClose={onClose} />;
  return (
    <FormDialog title="发放充值赠水券" submitLabel="确认发券" onClose={onClose} onSubmit={async () => {
      if (!member) throw new Error('请选择会员');
      await api.issueCoupon(template, member.id, key);
      await onDone?.();
      toast('优惠券已到账，符合套餐的下次充值可使用');
    }}>
      <Field label="会员" htmlFor="issueMember"><MemberPicker id="issueMember" value={member} onChange={setMember} /></Field>
      <Field label="优惠券" htmlFor="issueTemplate">
        <select id="issueTemplate" className="select" value={template} onChange={e => setTemplate(e.target.value)}>
          {templates.map(c => <option key={c.id} value={c.id}>{c.name} · 赠 {c.giftQty} 张 · 每人限 {c.perMemberLimit} 次</option>)}
        </select>
      </Field>
    </FormDialog>
  );
}

const RECHARGE_REFUND_REASONS = ['不再订水', '搬家', '水质或服务不满意', '重复充值'] as const;

/** 退清剩余权益只提交申请：管理员审核通过时才按剩余付费票退款并收回赠票。 */
export function RefundBatchDialog({ memberId, batch, onClose, onDone }: { memberId: string; batch: TicketBatch; onClose: () => void; onDone?: Done }) {
  const api = useApi();
  const toast = useToast();
  const key = useIdempotencyKey();
  const [pay, setPay] = useState<PayMethod>('CASH');
  const [reason, setReason] = useState('');
  return (
    <FormDialog title="申请退清剩余权益" description="提交后由管理员审核，审核通过才退款" submitLabel="提交退款申请" onClose={onClose} onSubmit={async () => {
      const request = await api.applyRefund({ kind: 'RECHARGE', memberId, batchId: batch.id, payMethod: pay, reason: reason.trim(), idempotencyKey: key });
      await onDone?.();
      toast(`退款申请 ${request.requestNo} 已提交，待管理员审核`);
    }}>
      <div className="membership-summary">
        <b>{batch.name}</b>
        <p>原实付 ¥{money(batch.paidAmount)} ÷ 固定 {batch.fixedQty}{unitOf(batch.waterType)}</p>
        <p>退付费票 {batch.remainingBuy}，收回赠票 {batch.remainingGift}</p>
        <strong>预计退 ¥{money(batch.refundableAmount)}</strong>
      </div>
      <Field label="会员希望的退款方式" htmlFor="refundPay"><select id="refundPay" className="select" value={pay} onChange={e => setPay(e.target.value as PayMethod)}><PayOptions /></select></Field>
      <Field label="退款原因" htmlFor="refundReason"><input id="refundReason" className="input" required maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></Field>
      <ReasonChips options={RECHARGE_REFUND_REASONS} value={reason} onPick={setReason} />
      <p className="membership-note">审核期间水票照常可用；审核通过时按当时剩余票数退款。本操作登记线下退款，不发起支付平台转账。桶押金独立结算。</p>
    </FormDialog>
  );
}

export function BatchCards({ batches, onRefund }: { batches: TicketBatch[]; onRefund?: (batch: TicketBatch) => void }) {
  if (!batches.length) return <p className="membership-note">暂无充值水票</p>;
  return <>{batches.map(b => {
    const legacy = b.source === 'LEGACY';
    const reserved = b.reservedBuy + b.reservedGift;
    const reviewing = b.status === 'ACTIVE' && !!b.pendingRequestNo;
    return (
      <article key={b.id} className="membership-card">
        <div className="membership-card-head">
          <b>{b.name}</b>
          {reviewing
            ? <span className="tag orange" title={`申请单 ${b.pendingRequestNo}`}>退款审核中</span>
            : <span className={`tag ${b.status === 'REFUNDED' ? 'gray' : 'green'}`}>{b.status === 'REFUNDED' ? '已退款' : modeLabel(b.fulfillMode)}</span>}
        </div>
        <small>{b.rechargeNo || '历史余额'} · {b.waterLabel || waterFallbackLabel(b.waterType)}</small>
        <p>剩余付费 {legacy ? '待核对' : b.remainingBuy} · 剩余赠票 {legacy ? '待核对' : b.remainingGift} · 预占 {reserved}</p>
        {legacy
          ? <p className="membership-note">历史余量 {b.remainingBuy + b.remainingGift} 张；可继续使用，原价及购赠来源待核对。</p>
          : <p>原实付 ¥{money(b.paidAmount)} / 固定 {b.fixedQty}{unitOf(b.waterType)}{b.status === 'REFUNDED' ? ` · 已退 ¥${money(b.refundedAmount)}` : ''}</p>}
        {onRefund && b.source === 'PURCHASE' && b.status === 'ACTIVE' && b.remainingBuy + b.remainingGift > 0 && (
          <button type="button" className="btn sm" disabled={reserved > 0 || reviewing} onClick={() => onRefund(b)}>
            {reviewing ? `退款审核中 · ${b.pendingRequestNo}` : reserved > 0 ? '订单占用中' : `申请退清剩余权益 · 约 ¥${money(b.refundableAmount)}`}
          </button>
        )}
      </article>
    );
  })}</>;
}

export function CouponCards({ coupons }: { coupons: MemberCoupon[] }) {
  if (!coupons.length) return <p className="membership-note">暂无优惠券</p>;
  const now = new Date();
  return <>{coupons.map(c => {
    const expired = new Date(c.snapshot.expiresAt) <= now;
    const pending = new Date(c.snapshot.startsAt) > now;
    return (
      <article key={c.id} className="membership-card">
        <b>{c.snapshot.name}</b>
        <span className={`tag ${c.status === 'USED' || expired ? 'gray' : 'gold'}`}>{c.status === 'USED' ? '已使用' : expired ? '已过期' : pending ? '未生效' : '可使用'}</span>
        <p>额外赠 {c.snapshot.giftQty} 张水票</p>
        <small>有效期至 {new Date(c.snapshot.expiresAt).toLocaleString('zh-CN')}</small>
      </article>
    );
  })}</>;
}

/** Recharge batches and coupons of one member; staff with permissions can recharge, issue coupons and refund from here. */
export function MemberAssetsDialog({ memberId, memberName, onClose, onDone }: { memberId: string; memberName: string; onClose: () => void; onDone?: Done }) {
  const { api, can } = useAuth();
  const dialogs = useDialogs();
  const run = useRun();
  const [data, setData] = useState<{ batches: TicketBatch[]; coupons: MemberCoupon[] } | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => Promise.all([api.ticketBatches(memberId), api.memberCoupons(memberId)])
    .then(([batches, coupons]) => { setData({ batches, coupons }); setError(''); })
    .catch(e => setError(errorText(e))), [api, memberId]);
  useEffect(() => { void load(); }, [load]);
  const changed = async () => { await onDone?.(); await load(); };
  return (
    <Dialog title={`${memberName} · 水票与优惠券`} onClose={onClose}>
      {can(P.RechargeCreate) && (
        <div className="membership-actions">
          <button type="button" className="btn primary" onClick={run(() => dialogs.open(close => <RechargeDialog memberId={memberId} onClose={close} onDone={changed} />))}>充值</button>
          <button type="button" className="btn" onClick={run(() => dialogs.open(close => <IssueCouponDialog memberId={memberId} onClose={close} onDone={changed} />))}>发券</button>
        </div>
      )}
      {error && <p className="account-error" role="alert">{error}</p>}
      <h3>充值批次</h3>
      {data ? <BatchCards batches={data.batches} onRefund={can(P.RechargeCreate) || can(P.RechargeRefund) ? batch => run(() => dialogs.open(close => <RefundBatchDialog memberId={memberId} batch={batch} onClose={close} onDone={changed} />))() : undefined} /> : <p className="membership-note">正在加载…</p>}
      <h3>我的优惠券</h3>
      {data ? <CouponCards coupons={data.coupons} /> : <p className="membership-note">正在加载…</p>}
    </Dialog>
  );
}
