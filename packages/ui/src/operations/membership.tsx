import { useCallback, useEffect, useState } from 'react';
import {
  KUNLUN_PERMISSIONS as P, modeLabel, money, unitOf, waterFallbackLabel,
  type PayMethod, type RechargePlan, type TicketBatch, type WaterProduct,
} from '@kunlun/shared';
import { useAuth } from '../auth';
import { Dialog, Field, FormDialog, useDialogs, useRun, useToast } from '../feedback';
import { useIdempotencyKey } from '../hooks';
import { Stepper } from '../ordering';
import { PlanChooser } from '../plan-picker';
import { MemberPicker, PayButtons, ReasonChips, UnavailableDialog, errorText, usePickedMember, useReviewSettings, waitsForReview, type Done } from './common';

/** 收水费、按套餐发水票，可手动加赠送；店员的赠送在后台要求审核时等管理员批准后才到账，付费的水票当场到账。 */
export function RechargeDialog({ memberId, onClose, onDone }: { memberId?: string; onClose: () => void; onDone?: Done }) {
  const { api, can } = useAuth();
  const toast = useToast();
  const key = useIdempotencyKey();
  const review = useReviewSettings();
  const [catalog, setCatalog] = useState<{ plans: RechargePlan[]; products: WaterProduct[] } | null>(null);
  const [member, setMember] = usePickedMember(memberId);
  const [plan, setPlan] = useState<RechargePlan | null>(null);
  const [gift, setGift] = useState(0);
  const [pay, setPay] = useState<PayMethod>('CASH');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let alive = true;
    Promise.all([api.listPlans(), api.listProducts()])
      .then(([plans, products]) => alive && setCatalog({ plans, products }))
      .catch(e => alive && setLoadError(errorText(e)));
    return () => { alive = false; };
  }, [api]);
  if (!can(P.RechargeCreate)) return <UnavailableDialog title="水费充值" message="当前账号没有充值权限" onClose={onClose} />;
  if (loadError) return <UnavailableDialog title="水费充值" message={loadError} onClose={onClose} />;
  if (catalog && !catalog.plans.some(p => p.status === 'ACTIVE')) return <UnavailableDialog title="水费充值" message="请先配置并启用充值套餐" onClose={onClose} />;

  const unit = plan ? unitOf(plan.waterType) : '桶';
  const giftWaits = gift > 0 && waitsForReview(review, 'gift', can(P.RechargeRefund));
  const submit = async () => {
    if (!member) throw new Error('请选择会员');
    if (!plan) throw new Error('请选择充值套餐');
    const result = await api.createRecharge({ memberId: member.id, planId: plan.id, payMethod: pay, giftQty: gift, idempotencyKey: key });
    await onDone?.();
    toast(result.pendingGiftQty > 0
      ? `充值成功：到账 ${result.totalTickets}${unit}；赠送 ${result.pendingGiftQty}${unit}等管理员批准后到账`
      : `充值成功：到账 ${result.totalTickets}${unit}${result.giftQty ? `（含赠送 ${result.giftQty}${unit}）` : ''}`);
  };
  return (
    <FormDialog title="水费充值" submitLabel={plan ? `确认已收 ¥${money(plan.price)}` : '确认已收款'} onClose={onClose} onSubmit={submit}>
      <Field label="会员" htmlFor="chargeMember"><MemberPicker id="chargeMember" value={member} onChange={setMember} /></Field>
      <label id="chargePlanLabel">充值套餐</label>
      {catalog ? <PlanChooser labelledBy="chargePlanLabel" plans={catalog.plans} products={catalog.products} value={plan} onChange={setPlan} /> : <p className="membership-note">正在加载套餐…</p>}
      <Field label={`另外赠送几${unit}（不送就是 0）`} htmlFor="chargeGift"><Stepper id="chargeGift" label="赠送数量" value={gift} onChange={setGift} max={1000} /></Field>
      <label id="chargePayLabel">收款方式</label>
      <PayButtons labelledBy="chargePayLabel" value={pay} onChange={setPay} />
      <div className="deposit-total">
        <span>到账水票</span>
        <b>{plan ? `${plan.buyQty + gift} ${unit}` : '—'}</b>
        <small>{!plan ? '请选择充值套餐' : `付费 ${plan.buyQty}${unit}${gift ? ` + 赠送 ${gift}${unit}` : ''} · ${modeLabel(plan.fulfillMode)}票；收水费 ¥${money(plan.price)}，押金另收`}</small>
      </div>
      {giftWaits && <p className="membership-note">赠送要管理员批准后才到账，付费的水票现在就到账。</p>}
    </FormDialog>
  );
}

const RECHARGE_REFUND_REASONS = ['不再订水', '搬家', '水质或服务不满意', '重复充值'] as const;

/** 退清一次充值的剩余水票：后台要求审核时店员只提交申请，管理员通过才退款；不要求审核或管理员办理时当场退款。 */
export function RefundBatchDialog({ memberId, batch, onClose, onDone }: { memberId: string; batch: TicketBatch; onClose: () => void; onDone?: Done }) {
  const { api, can } = useAuth();
  const toast = useToast();
  const key = useIdempotencyKey();
  const review = useReviewSettings();
  const [pay, setPay] = useState<PayMethod>('CASH');
  const [reason, setReason] = useState('');
  const waits = waitsForReview(review, 'refund', can(P.RechargeRefund));
  return (
    <FormDialog title={waits ? '申请退清剩余水票' : '退清剩余水票'} description={waits ? '提交后由管理员审核，审核通过才退款' : '确认后当场退款，剩余水票同时作废'}
      submitLabel={waits ? '提交退款申请' : `确认已退 ¥${money(batch.refundableAmount)}`} onClose={onClose} onSubmit={async () => {
        const result = await api.applyRefund({ kind: 'RECHARGE', memberId, batchId: batch.id, payMethod: pay, reason: reason.trim(), idempotencyKey: key });
        await onDone?.();
        toast(result.status === 'APPROVED' ? `已退款 ¥${money(result.refundAmount ?? 0)}` : `退款申请 ${result.requestNo} 已提交，等管理员审核`);
      }}>
      <div className="membership-summary">
        <b>{batch.name}</b>
        <p>原实付 ¥{money(batch.paidAmount)} ÷ {batch.fixedQty}{unitOf(batch.waterType)}；退剩余付费 {batch.remainingBuy}{unitOf(batch.waterType)}，收回赠送 {batch.remainingGift}{unitOf(batch.waterType)}</p>
        <strong>{waits ? '预计退' : '应退'} ¥{money(batch.refundableAmount)}</strong>
      </div>
      <label id="refundPayLabel">退款方式</label>
      <PayButtons labelledBy="refundPayLabel" value={pay} onChange={setPay} />
      <Field label="退款原因（选填）" htmlFor="refundReason"><input id="refundReason" className="input" maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></Field>
      <ReasonChips options={RECHARGE_REFUND_REASONS} value={reason} onPick={setReason} />
      <p className="membership-note">{waits ? '审核期间水票照常可用；通过时按当时剩余票数退款。' : ''}只登记线下退款，不发起支付平台转账；押金另行退。</p>
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
        {b.pendingGiftQty > 0 && <p className="membership-note">另有赠送 {b.pendingGiftQty}{unitOf(b.waterType)}，等管理员批准后到账</p>}
        {onRefund && b.source === 'PURCHASE' && b.status === 'ACTIVE' && b.remainingBuy + b.remainingGift > 0 && (
          <button type="button" className="btn sm" disabled={reserved > 0 || reviewing} onClick={() => onRefund(b)}>
            {reviewing ? `退款审核中 · ${b.pendingRequestNo}` : reserved > 0 ? '订单占用中' : `退清剩余水票 · 约 ¥${money(b.refundableAmount)}`}
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
