import { useCallback, useEffect, useState } from 'react';
import {
  KUNLUN_PERMISSIONS as P, modeLabel, money, unitOf, waterFallbackLabel,
  type PayMethod, type RechargePlan, type TicketBatch,
} from '@kunlun/shared';
import { useApi, useAuth } from '../auth';
import { Dialog, Field, FormDialog, useDialogs, useRun, useToast } from '../feedback';
import { useIdempotencyKey } from '../hooks';
import { PlanSelector } from '../plan-picker';
import { MemberPicker, PayOptions, ReasonChips, UnavailableDialog, errorText, usePickedMember, type Done } from './common';

export function RechargeDialog({ memberId, onClose, onDone }: { memberId?: string; onClose: () => void; onDone?: Done }) {
  const { api, can } = useAuth();
  const toast = useToast();
  const key = useIdempotencyKey();
  const [hasPlans, setHasPlans] = useState<boolean | null>(null);
  const [member, setMember] = usePickedMember(memberId);
  const [plan, setPlan] = useState<RechargePlan | null>(null);
  const [pay, setPay] = useState<PayMethod>('CASH');
  const [loadError, setLoadError] = useState('');

  useEffect(() => { api.listPlans().then(p => setHasPlans(p.some(x => x.status === 'ACTIVE'))).catch(e => setLoadError(errorText(e))); }, [api]);
  if (!can(P.RechargeCreate)) return <UnavailableDialog title="水费充值登记" message="当前账号没有充值权限" onClose={onClose} />;
  if (loadError) return <UnavailableDialog title="水费充值登记" message={loadError} onClose={onClose} />;
  if (hasPlans === false) return <UnavailableDialog title="水费充值登记" message="请先配置并启用充值套餐" onClose={onClose} />;

  const gift = plan?.giftQty ?? 0;
  const submit = async () => {
    if (!member) throw new Error('请选择会员');
    if (!plan) throw new Error('请选择启用中的充值套餐');
    const result = await api.createRecharge({ memberId: member.id, planId: plan.id, payMethod: pay, idempotencyKey: key });
    await onDone?.();
    toast(`充值成功：付费 ${result.buyQty} + 赠送 ${result.giftQty}，共 ${result.totalTickets} 张水票`);
  };
  return (
    <FormDialog title="水费充值登记" submitLabel="确认已收款并登记" onClose={onClose} onSubmit={submit}>
      <Field label="会员" htmlFor="chargeMember"><MemberPicker id="chargeMember" value={member} onChange={setMember} /></Field>
      <Field label="充值套餐" htmlFor="chargePlanPicker"><PlanSelector id="chargePlanPicker" plan={plan} onChange={setPlan} /></Field>
      <div className="membership-summary">
        {plan ? `实收 ¥${money(plan.price)} · ${modeLabel(plan.fulfillMode)}付费 ${plan.buyQty}${unitOf(plan.waterType)} + 赠送 ${gift}${unitOf(plan.waterType)} = 共 ${plan.buyQty + gift}${unitOf(plan.waterType)}` : '请选择充值套餐'}
      </div>
      <Field label="实际收款方式" htmlFor="chargePay"><select id="chargePay" className="select" value={pay} onChange={e => setPay(e.target.value as PayMethod)}><PayOptions /></select></Field>
      <p className="membership-note">确认线下已收款后登记；押金另行办理。</p>
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

/** Recharge batches of one member; staff with permissions can recharge and refund from here. */
export function MemberAssetsDialog({ memberId, memberName, onClose, onDone }: { memberId: string; memberName: string; onClose: () => void; onDone?: Done }) {
  const { api, can } = useAuth();
  const dialogs = useDialogs();
  const run = useRun();
  const [batches, setBatches] = useState<TicketBatch[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api.ticketBatches(memberId)
    .then(list => { setBatches(list); setError(''); })
    .catch(e => setError(errorText(e))), [api, memberId]);
  useEffect(() => { void load(); }, [load]);
  const changed = async () => { await onDone?.(); await load(); };
  return (
    <Dialog title={`${memberName} · 水票与充值`} onClose={onClose}>
      {can(P.RechargeCreate) && (
        <div className="membership-actions">
          <button type="button" className="btn primary" onClick={run(() => dialogs.open(close => <RechargeDialog memberId={memberId} onClose={close} onDone={changed} />))}>充值</button>
        </div>
      )}
      {error && <p className="account-error" role="alert">{error}</p>}
      <h3>充值批次</h3>
      {batches ? <BatchCards batches={batches} onRefund={can(P.RechargeCreate) || can(P.RechargeRefund) ? batch => run(() => dialogs.open(close => <RefundBatchDialog memberId={memberId} batch={batch} onClose={close} onDone={changed} />))() : undefined} /> : <p className="membership-note">正在加载…</p>}
    </Dialog>
  );
}
