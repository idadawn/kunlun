import { useEffect, useState } from 'react';
import { KUNLUN_PERMISSIONS as P, containerKind, containerLabel, containerUnit, money, type ContainerSummaryItem, type ContainerType, type DepositSummaryRow, type PayMethod } from '@kunlun/shared';
import { useAuth } from '../auth';
import { Field, FormDialog, useToast } from '../feedback';
import { useLoader, useIdempotencyKey } from '../hooks';
import { Icon } from '../icons';
import { Stepper } from '../ordering';
import { MemberPicker, PayButtons, ReasonChips, UnavailableDialog, errorText, usePickedMember, useReviewSettings, waitsForReview, type Done } from './common';

export type DepositAction = 'collect' | 'refund';

const REFUND_REASONS = ['不再订水', '搬家', '容器已全部归还', '退回多交押金'] as const;

/**
 * 押金收退：与水费充值分开办理。先选业务和会员，再选水品配套容器，直接显示该会员对应的已交、持有和可退数量。
 * 收押金当场登记；退押金在后台要求审核时店员只提交申请，管理员通过才退款，否则当场退款。
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
  const [quantity, setQuantity] = useState(1);
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

  const collect = action === 'collect';
  const row = summary?.find(r => r.containerType === container);
  const unitDeposit = containers.find(c => c.containerType === container)?.unitDeposit;
  const available = row ? applicable(row) : 0;
  const over = !collect && !!row && quantity > available;
  const submit = async () => {
    if (!member) throw new Error('请选择会员');
    if (over) throw new Error(`最多可申请退 ${available} 个，请先登记归还容器`);
    if (collect) {
      const result = await api.collectDeposit({ memberId: member.id, containerType: container, quantity, payMethod: pay, idempotencyKey: key });
      await onDone?.();
      toast(`已收押金 ¥${money(result.totalAmount)}`);
      return;
    }
    const result = await api.applyRefund({ kind: 'DEPOSIT', memberId: member.id, containerType: container, quantity, payMethod: pay, reason: reason.trim(), idempotencyKey: key });
    await onDone?.();
    toast(result.status === 'APPROVED' ? `已退押金 ¥${money(result.refundAmount ?? 0)}` : `退押金申请 ${result.requestNo} 已提交，等管理员审核`);
  };
  const refundLabel = waits ? '申请退押金' : '退押金';
  return (
    <FormDialog title={collect ? '收押金' : refundLabel}
      description={collect ? '押金单独记账：不算水费，也不送水' : waits ? '提交后由管理员审核，审核通过才退款' : '确认后当场退款，按原收款单价计算'}
      submitLabel={collect ? '确认已收款' : waits ? '提交退款申请' : '确认已退款'} onClose={onClose} onSubmit={submit}>
      {canCollect && canRefund && (
        <div className="seg-switch" role="group" aria-label="押金业务">
          {(['collect', 'refund'] as const).map(a => (
            <button key={a} type="button" aria-pressed={action === a} onClick={() => setAction(a)}>{a === 'collect' ? '收押金' : refundLabel}</button>
          ))}
        </div>
      )}
      <Field label="会员" htmlFor="depositMember"><MemberPicker id="depositMember" value={member} onChange={setMember} /></Field>
      <label id="depositContainerLabel">水品配套桶袋</label>
      <div className="mode-switch deposit-containers" role="group" aria-labelledby="depositContainerLabel">
        {containers.map(c => c.containerType).map(type => {
          const r = summary?.find(x => x.containerType === type);
          const unit = containers.find(c => c.containerType === type)?.unitDeposit;
          return (
            <button key={type} type="button" className={container === type ? 'active' : ''} aria-pressed={container === type} onClick={() => setContainer(type)}>
              <Icon name={containerKind(type) === 'BUCKET' ? 'drop' : 'box'} />
              <span>
                <b>{containerLabel(type)}</b>
                <small>{unit === undefined ? '押金标准加载中' : `押金 ¥${money(unit)}/个`}</small>
                {r && <small>已交 {r.paidQty} · 持有 {r.heldQty} · 可退 <em>{applicable(r)}</em>{r.pendingRefundQty > 0 && ` · 审核中 ${r.pendingRefundQty}`}</small>}
              </span>
            </button>
          );
        })}
      </div>
      <Field label={collect ? '收几个的押金' : '退几个的押金'} htmlFor="depositQuantity">
        <div className="deposit-qty">
          <Stepper id="depositQuantity" label="押金个数" value={quantity} onChange={setQuantity} min={1} max={10000} />
          {!collect && available > 0 && <button type="button" className="btn sm" onClick={() => setQuantity(available)}>全部可退 {available} 个</button>}
        </div>
      </Field>
      <label id="depositPayLabel">{collect ? '收款方式' : '退款方式'}</label>
      <PayButtons labelledBy="depositPayLabel" value={pay} onChange={setPay} />
      {!collect && <>
        <Field label="退款原因（选填）" htmlFor="depositReason"><input id="depositReason" className="input" maxLength={500} placeholder="如：不再订水" value={reason} onChange={e => setReason(e.target.value)} /></Field>
        <ReasonChips options={REFUND_REASONS} value={reason} onPick={setReason} />
      </>}
      <DepositTotal collect={collect} waits={waits} quantity={quantity} unitDeposit={unitDeposit} row={row} hasMember={!!owner} error={previewError} />
    </FormDialog>
  );
}

/** What a new refund request may still cover: refundable now, less what is already waiting for review. */
const applicable = (row: DepositSummaryRow) => Math.max(0, row.refundableQty - row.pendingRefundQty);

function DepositTotal({ collect, waits, quantity, unitDeposit, row, hasMember, error }: {
  collect: boolean; waits: boolean; quantity: number; unitDeposit?: number; row?: DepositSummaryRow; hasMember: boolean; error: string;
}) {
  if (error) return <p className="account-error" role="alert">{error}</p>;
  if (collect) return (
    <div className="deposit-total">
      <span>应收押金</span>
      <b>{unitDeposit === undefined ? '—' : `¥ ${money(unitDeposit * quantity)}`}</b>
      <small>{unitDeposit === undefined ? '押金标准加载中' : `${quantity} 个 × ¥${money(unitDeposit)}，按现行押金标准收取；交押金不改变会员手里的桶袋数`}</small>
    </div>
  );
  const title = waits ? '预计退还' : '应退押金';
  if (!hasMember) return <div className="deposit-total"><span>{title}</span><b>—</b><small>请选择会员后查询可退押金</small></div>;
  if (!row) return <div className="deposit-total"><span>{title}</span><b>—</b><small>正在查询可退押金…</small></div>;
  const available = applicable(row);
  const over = quantity > available;
  // Exact only when nothing else is waiting and the whole refundable quantity is asked back; otherwise the FIFO lots decide.
  const exact = row.pendingRefundQty === 0 && quantity === row.refundableQty;
  return (
    <div className={`deposit-total${over ? ' warn' : ''}`}>
      <span>{title}</span>
      <b>{available === 0 ? '没有可退的押金' : over ? `最多可退 ${available} 个` : exact ? `¥ ${money(row.refundableAmount)}` : '按原批次单价计算'}</b>
      <small>
        {over
          ? `超出可退数量：已交未退 ${row.paidQty} 个，会员手里 ${row.heldQty} 个${row.pendingDamageQty ? `，待报废 ${row.pendingDamageQty} 个` : ''}${row.pendingRefundQty ? `，已有 ${row.pendingRefundQty} 个在审核中` : ''}。请先登记还回桶袋。`
          : waits
            ? '审核通过时按原收款批次单价先进先出计算实退金额，不按现行标准；提交申请不会动押金余额。'
            : '按原收款批次单价先进先出计算，不按现行标准；确认后押金余额随即减少。'}
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
