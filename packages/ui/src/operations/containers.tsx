import { useEffect, useState } from 'react';
import { KUNLUN_PERMISSIONS as P, containerKind, containerLabel, containerUnit, money, type ContainerSummaryItem, type ContainerType, type DepositSummaryRow, type PayMethod } from '@kunlun/shared';
import { useAuth } from '../auth';
import { Field, FormDialog, useToast } from '../feedback';
import { useLoader, useIdempotencyKey } from '../hooks';
import { Icon } from '../icons';
import { Stepper } from '../ordering';
import { MemberPicker, PayButtons, ReasonChips, UnavailableDialog, errorText, parseYuan, sameYuan, usePickedMember, useReviewSettings, waitsForReview, type Done } from './common';

export type DepositAction = 'collect' | 'refund';

const REFUND_REASONS = ['不再订水', '搬家', '容器已全部归还', '退回多交押金'] as const;

/**
 * 押金收退：与水费充值分开办理。先选业务和会员，再选水品配套容器，直接填收了或退了多少钱：收押金按现行标准折成几个，
 * 退押金按原收款单价先进先出折成几个，个数可以再改。退的比这几个的押金原价少，差额记为扣押金。
 * 收押金当场登记；退押金在后台要求审核时店员只提交申请，管理员确认金额后才退款，否则当场退款。
 */
export function DepositDialog({ containers, memberId, action: initialAction, onClose, onDone }: {
  containers: ContainerSummaryItem[];
  memberId?: string;
  action?: DepositAction;
  onClose: () => void;
  onDone?: Done;
}) {
  const { api, can } = useAuth();
  const toast = useToast();
  const key = useIdempotencyKey();
  const review = useReviewSettings();
  const canCollect = can(P.DepositCollect);
  const canRefund = can(P.DepositRefundApprove) || can(P.DepositRefundApply);
  const waits = waitsForReview(review, 'refund', can(P.DepositRefundApprove));
  const [member, setMember] = usePickedMember(memberId);
  const [container, setContainer] = useState<ContainerType>('BUCKET');
  const [action, setAction] = useState<DepositAction>(initialAction === 'refund' && canRefund || !canCollect ? 'refund' : 'collect');
  // Both start from the books (null) until staff type an amount or set a count themselves.
  const [typed, setTyped] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [pay, setPay] = useState<PayMethod>('CASH');
  const [reason, setReason] = useState('');
  const [summary, setSummary] = useState<DepositSummaryRow[] | null>(null);
  const [previewError, setPreviewError] = useState('');

  const owner = member?.id;
  useEffect(() => {
    let alive = true;
    setSummary(null); setPreviewError('');
    if (owner) api.depositSummary(owner)
      .then(rows => { if (alive) setSummary(rows); })
      .catch(e => { if (alive) setPreviewError(errorText(e)); });
    return () => { alive = false; };
  }, [api, owner]);

  if (!canCollect && !canRefund) return <UnavailableDialog title="押金办理" message="当前账号没有押金办理权限" onClose={onClose} />;

  const restart = () => { setTyped(null); setCount(null); };
  const collect = action === 'collect';
  const unit = containerUnit(container);
  const row = summary?.find(r => r.containerType === container);
  const unitDeposit = containers.find(c => c.containerType === container)?.unitDeposit;
  const available = row ? applicable(row) : 0;
  const worth = (n: number) => row ? refundValue(row, n) : 0;
  const books = collect ? (unitDeposit ?? 0) * (count ?? 1) : worth(count ?? available);
  const amountText = typed ?? (books > 0 ? money(books) : '');
  const value = parseYuan(amountText);
  const quantity = count ?? (collect
    ? (value && unitDeposit ? Math.max(1, Math.round(value / unitDeposit)) : 1)
    : value === null || value === 0 ? Math.max(available, 1) : refundCount(row, available, value));
  const each = value === null ? null : value / quantity;
  const splits = value !== null && Math.round(value * 100) % quantity === 0;
  const original = collect ? 0 : worth(quantity);
  const over = !collect && !!row && quantity > available;
  const submit = async () => {
    if (!member) throw new Error('请选择会员');
    if (value === null) throw new Error(`请填写${collect ? '收' : '退'}了多少钱，最多两位小数`);
    if (collect) {
      if (value <= 0) throw new Error('收的押金要大于 0');
      if (!splits) throw new Error(`¥${money(value)} 分到 ${quantity} 个${unit}不是整分，请改个数或金额`);
      const result = await api.collectDeposit({ memberId: member.id, containerType: container, quantity, payMethod: pay, idempotencyKey: key, amount: value });
      await onDone?.();
      toast(`已收押金 ¥${money(result.totalAmount)}（${quantity} 个${unit}）`);
      return;
    }
    if (over) throw new Error(`最多可退 ${available} 个的押金，请先登记归还容器`);
    if (value > original) throw new Error(`${quantity} 个${unit}的押金按原价一共 ¥${money(original)}，退的不能比这多`);
    const result = await api.applyRefund({ kind: 'DEPOSIT', memberId: member.id, containerType: container, quantity, payMethod: pay, reason: reason.trim(), idempotencyKey: key, amount: value });
    await onDone?.();
    toast(result.status === 'APPROVED' ? `已退押金 ¥${money(result.refundAmount ?? 0)}` : `退押金申请 ${result.requestNo} 已提交，等管理员审核`);
  };
  const refundLabel = waits ? '申请退押金' : '退押金';
  return (
    <FormDialog title={collect ? '收押金' : refundLabel}
      description={collect ? '押金单独记账：不算水费，也不送水' : waits ? '提交后由管理员审核，审核通过才退款' : '确认后当场退款；退得比原价少，差额记为扣押金'}
      submitLabel={collect ? (value ? `确认已收 ¥${money(value)}` : '确认已收款') : waits ? '提交退款申请' : value !== null ? `确认已退 ¥${money(value)}` : '确认已退款'} onClose={onClose} onSubmit={submit}>
      {canCollect && canRefund && (
        <div className="seg-switch" role="group" aria-label="押金业务">
          {(['collect', 'refund'] as const).map(a => (
            <button key={a} type="button" aria-pressed={action === a} onClick={() => { setAction(a); restart(); }}>{a === 'collect' ? '收押金' : refundLabel}</button>
          ))}
        </div>
      )}
      <Field label="会员" htmlFor="depositMember"><MemberPicker id="depositMember" value={member} onChange={m => { setMember(m); restart(); }} /></Field>
      <label id="depositContainerLabel">水品配套桶袋</label>
      <div className="mode-switch deposit-containers" role="group" aria-labelledby="depositContainerLabel">
        {containers.map(c => c.containerType).map(type => {
          const r = summary?.find(x => x.containerType === type);
          const standard = containers.find(c => c.containerType === type)?.unitDeposit;
          return (
            <button key={type} type="button" className={container === type ? 'active' : ''} aria-pressed={container === type} onClick={() => { setContainer(type); restart(); }}>
              <Icon name={containerKind(type) === 'BUCKET' ? 'drop' : 'box'} />
              <span>
                <b>{containerLabel(type)}</b>
                <small>{standard === undefined ? '押金标准加载中' : `押金 ¥${money(standard)}/个`}</small>
                {r && <small>已交 {r.paidQty} · 持有 {r.heldQty} · 可退 <em>{applicable(r)}</em>{r.pendingRefundQty > 0 && ` · 审核中 ${r.pendingRefundQty}`}</small>}
              </span>
            </button>
          );
        })}
      </div>
      <Field label={collect ? '收了多少押金（元）' : waits ? '申请退多少押金（元）' : '退了多少押金（元）'} htmlFor="depositAmount">
        <input id="depositAmount" className="input deposit-amount" type="number" inputMode="decimal" required min={collect ? 0.01 : 0} step={0.01} placeholder="0.00"
          value={amountText} onChange={e => { setTyped(e.target.value); if (!collect) setCount(null); }} />
      </Field>
      <Field label={collect ? `算几个${unit}的押金` : `退几个${unit}的押金`} htmlFor="depositQuantity">
        <div className="deposit-qty">
          <Stepper id="depositQuantity" label="押金个数" value={quantity} min={1} max={10000}
            onChange={n => { setCount(n); if (!collect) setTyped(money(worth(n))); }} />
          {!collect && available > 0 && quantity !== available && (
            <button type="button" className="btn sm" onClick={() => { setCount(available); setTyped(money(worth(available))); }}>全部可退 {available} 个</button>
          )}
        </div>
      </Field>
      <label id="depositPayLabel">{collect ? '收款方式' : '退款方式'}</label>
      <PayButtons labelledBy="depositPayLabel" value={pay} onChange={setPay} />
      {!collect && <>
        <Field label="退款原因（选填）" htmlFor="depositReason"><input id="depositReason" className="input" maxLength={500} placeholder="如：不再订水" value={reason} onChange={e => setReason(e.target.value)} /></Field>
        <ReasonChips options={REFUND_REASONS} value={reason} onPick={setReason} />
      </>}
      <DepositTotal collect={collect} waits={waits} quantity={quantity} unit={unit} value={value} each={each} splits={splits} unitDeposit={unitDeposit}
        original={original} available={available} row={row} hasMember={!!owner} error={previewError} />
    </FormDialog>
  );
}

/** What a new refund request may still cover: refundable now, less what is already waiting for review. */
const applicable = (row: DepositSummaryRow) => Math.max(0, row.refundableQty - row.pendingRefundQty);

/** The deposit of the next `n` refundable containers at their original prices, oldest first, after those already under review. */
function refundValue(row: DepositSummaryRow, n: number) {
  let skip = row.pendingRefundQty; let left = n; let amount = 0;
  for (const lot of row.lots ?? []) {
    let usable = lot.quantity;
    const skipped = Math.min(skip, usable); skip -= skipped; usable -= skipped;
    const take = Math.min(left, usable); left -= take; amount += take * Number(lot.unitPrice);
    if (left === 0) break;
  }
  // Older servers send no lots: fall back to the average of what is refundable.
  if (!row.lots && row.refundableQty > 0) return Math.round(Number(row.refundableAmount) / row.refundableQty * n * 100) / 100;
  return Math.round(amount * 100) / 100;
}

/** The fewest containers whose deposit covers the amount typed in; all of them when it is more than they are worth. */
function refundCount(row: DepositSummaryRow | undefined, available: number, value: number) {
  if (!row || available === 0) return 1;
  for (let n = 1; n <= available; n++) if (refundValue(row, n) + 0.001 >= value) return n;
  return available;
}

function DepositTotal({ collect, waits, quantity, unit, value, each, splits, unitDeposit, original, available, row, hasMember, error }: {
  collect: boolean; waits: boolean; quantity: number; unit: string; value: number | null; each: number | null; splits: boolean; unitDeposit?: number;
  original: number; available: number; row?: DepositSummaryRow; hasMember: boolean; error: string;
}) {
  if (error) return <p className="account-error" role="alert">{error}</p>;
  if (collect) return (
    <div className={`deposit-total${value !== null && !splits ? ' warn' : ''}`}>
      <span>这次收押金</span>
      <b>{value === null ? '—' : `¥ ${money(value)}`}</b>
      <small>{value === null ? '填收了多少钱，个数按现行押金标准自动算，可以再改'
        : !splits ? `¥${money(value)} 分到 ${quantity} 个${unit}不是整分，请改个数或金额`
        : `${quantity} 个${unit}，每个 ¥${money(each!)}${unitDeposit !== undefined && !sameYuan(each!, unitDeposit) ? `（现行标准 ¥${money(unitDeposit)}）` : ''}；交押金不改变会员手里的桶袋数`}</small>
    </div>
  );
  const title = waits ? '申请退押金' : '实退押金';
  if (!hasMember) return <div className="deposit-total"><span>{title}</span><b>—</b><small>请选择会员后查询可退押金</small></div>;
  if (!row) return <div className="deposit-total"><span>{title}</span><b>—</b><small>正在查询可退押金…</small></div>;
  const over = quantity > available;
  const tooMuch = value !== null && !over && value > original + 0.001;
  const kept = value !== null && !over && !tooMuch ? original - value : 0;
  return (
    <div className={`deposit-total${over || tooMuch ? ' warn' : ''}`}>
      <span>{title}</span>
      <b>{available === 0 ? '没有可退的押金' : over ? `最多可退 ${available} 个` : value === null ? '—' : `¥ ${money(value)}`}</b>
      <small>
        {over
          ? `超出可退数量：已交未退 ${row.paidQty} 个，会员手里 ${row.heldQty} 个${row.pendingDamageQty ? `，待报废 ${row.pendingDamageQty} 个` : ''}${row.pendingRefundQty ? `，已有 ${row.pendingRefundQty} 个在审核中` : ''}。请先登记还回桶袋。`
          : tooMuch ? `${quantity} 个${unit}的押金按原收款单价一共 ¥${money(original)}，退的不能比这多`
          : `退 ${quantity} 个${unit}的押金，按原收款单价 ¥${money(original)}${kept > 0.001 ? `，少退的 ¥${money(kept)} 记为扣押金` : ''}；${waits ? '管理员审核通过时以他确认的金额为准，提交申请不会动押金。' : '确认后押金余额随即减少。'}`}
      </small>
    </div>
  );
}

/** 登记会员领走、还回的桶袋：同时更新会员手里的数量和店里库存，押金另行收退。 */
export function MovementDialog({ memberId, onClose, onDone }: { memberId?: string; onClose: () => void; onDone?: Done }) {
  const { api, can } = useAuth();
  const toast = useToast();
  const key = useIdempotencyKey();
  const [member, setMember] = usePickedMember(memberId);
  const [container, setContainer] = useState<ContainerType>('BUCKET');
  const [fullOut, setFullOut] = useState(0);
  const [emptyIn, setEmptyIn] = useState(1);
  const summary = useLoader(() => member ? api.depositSummary(member.id) : Promise.resolve([]), [api, member?.id]);
  if (!can(P.ContainerRegister) && !can(P.OrderFulfill)) return <UnavailableDialog title="登记领还桶袋" message="当前账号没有容器登记权限" onClose={onClose} />;
  const unit = containerUnit(container);
  const held = (type: ContainerType) => summary.data?.find(r => r.containerType === type)?.heldQty ?? null;
  const before = held(container);
  const after = before === null ? null : before + fullOut - emptyIn;
  return (
    <FormDialog title="登记领还桶袋" submitLabel="确认登记" onClose={onClose} onSubmit={async () => {
      if (!member) throw new Error('请选择会员');
      if (fullOut + emptyIn === 0) throw new Error(`请填写领走或还回的${unit}数`);
      const result = await api.registerMovement({ memberId: member.id, containerType: container, fullOutN: fullOut, emptyInM: emptyIn, idempotencyKey: key });
      await onDone?.();
      toast(`已登记，${member.name}手里现有 ${result.currentHeld} 个${containerLabel(container)}`);
    }}>
      <Field label="会员" htmlFor="moveMember"><MemberPicker id="moveMember" value={member} onChange={setMember} /></Field>
      <label id="moveContainerLabel">水品配套桶袋</label>
      <div className="mode-switch" role="group" aria-labelledby="moveContainerLabel">
        {(summary.data ?? []).map(row => row.containerType).map(type => (
          <button key={type} type="button" className={container === type ? 'active' : ''} aria-pressed={container === type} onClick={() => setContainer(type)}>
            <Icon name={containerKind(type) === 'BUCKET' ? 'drop' : 'box'} />
            <span><b>{containerLabel(type)}</b><small>{member ? `会员手里 ${held(type)} 个` : '选择会员后显示手里数量'}</small></span>
          </button>
        ))}
      </div>
      <div className="movement-counts">
        <div><Field label={`领走满${unit}（个）`} htmlFor="moveOut"><Stepper id="moveOut" label={`领走满${unit}`} value={fullOut} onChange={setFullOut} max={10000} /></Field></div>
        <div><Field label={`还回空${unit}（个）`} htmlFor="moveIn"><Stepper id="moveIn" label={`还回空${unit}`} value={emptyIn} onChange={setEmptyIn} max={10000} /></Field></div>
      </div>
      <div className={`deposit-total${after !== null && after < 0 ? ' warn' : ''}`}>
        <span>登记后会员手里</span>
        <b>{after === null ? '—' : `${before} → ${after} 个`}</b>
        <small>{after !== null && after < 0 ? `还回的比会员手里的多，请核对数量` : '同时更新店里库存；押金另行收退，领走超出已交押金时需先补交'}</small>
      </div>
    </FormDialog>
  );
}
