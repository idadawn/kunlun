import { useEffect, useState } from 'react';
import { KUNLUN_PERMISSIONS as P, containerLabel, money, type ContainerSummaryItem, type ContainerType, type DepositSummaryRow, type PayMethod } from '@kunlun/shared';
import { useAuth } from '../auth';
import { Field, FormDialog, useToast } from '../feedback';
import { useIdempotencyKey } from '../hooks';
import { Icon } from '../icons';
import { MemberPicker, PayOptions, ReasonChips, UnavailableDialog, errorText, usePickedMember, type Done } from './common';

const ContainerOptions = () => <><option value="BUCKET">15L 周转桶</option><option value="BAG">5L 周转水袋</option></>;

export type DepositAction = 'collect' | 'refund';

const REFUND_REASONS = ['不再订水', '搬家', '容器已全部归还', '退回多交押金'] as const;

/**
 * 押金收退：与水费充值分开办理。先选业务和会员，再从桶、袋两张卡片里选容器，卡片上直接显示该会员已交、持有和可退数量。
 * 收押金当场登记；退押金只提交申请，管理员审核通过后才退款。
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
  const canCollect = can(P.DepositCollect);
  const canRefund = can(P.DepositRefundApprove) || can(P.DepositRefundApply);
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
      toast(`收押金登记成功：¥${money(result.totalAmount)}`);
      return;
    }
    const request = await api.applyRefund({ kind: 'DEPOSIT', memberId: member.id, containerType: container, quantity, payMethod: pay, reason: reason.trim(), idempotencyKey: key });
    await onDone?.();
    toast(`退押金申请 ${request.requestNo} 已提交，待管理员审核`);
  };
  return (
    <FormDialog title={collect ? '收取押金' : '申请退押金'}
      description={collect ? '押金独立记账：不计入水费实收，不触发赠水' : '提交后由管理员审核，审核通过才退款'}
      submitLabel={collect ? '确认已收款并登记' : '提交退款申请'} onClose={onClose} onSubmit={submit}>
      {canCollect && canRefund && (
        <div className="seg-switch" role="group" aria-label="押金业务">
          {(['collect', 'refund'] as const).map(a => (
            <button key={a} type="button" aria-pressed={action === a} onClick={() => setAction(a)}>{a === 'collect' ? '收押金' : '申请退押金'}</button>
          ))}
        </div>
      )}
      <Field label="会员" htmlFor="depositMember"><MemberPicker id="depositMember" value={member} onChange={setMember} /></Field>
      <label id="depositContainerLabel">容器</label>
      <div className="mode-switch deposit-containers" role="group" aria-labelledby="depositContainerLabel">
        {CONTAINERS.map(type => {
          const r = summary?.find(x => x.containerType === type);
          const unit = containers.find(c => c.containerType === type)?.unitDeposit;
          return (
            <button key={type} type="button" className={container === type ? 'active' : ''} aria-pressed={container === type} onClick={() => setContainer(type)}>
              <Icon name={type === 'BUCKET' ? 'drop' : 'box'} />
              <span>
                <b>{containerLabel(type)}</b>
                <small>{unit === undefined ? '押金标准加载中' : `押金 ¥${money(unit)}/个`}</small>
                {r && <small>已交 {r.paidQty} · 持有 {r.heldQty} · 可退 <em>{applicable(r)}</em>{r.pendingRefundQty > 0 && ` · 审核中 ${r.pendingRefundQty}`}</small>}
              </span>
            </button>
          );
        })}
      </div>
      <Field label={collect ? '收取数量' : '申请退还数量'} htmlFor="depositQuantity">
        <div className="deposit-qty">
          <input id="depositQuantity" className="input" type="number" min={1} step={1} required value={quantity} onChange={e => setQuantity(Number(e.target.value))} />
          {!collect && available > 0 && <button type="button" className="btn sm" onClick={() => setQuantity(available)}>全部可退 {available} 个</button>}
        </div>
      </Field>
      <Field label={collect ? '收款方式' : '会员希望的退款方式'} htmlFor="depositPayment"><select id="depositPayment" className="select" value={pay} onChange={e => setPay(e.target.value as PayMethod)}><PayOptions /></select></Field>
      {!collect && <>
        <Field label="退款原因（选填）" htmlFor="depositReason"><input id="depositReason" className="input" maxLength={500} placeholder="如：不再订水" value={reason} onChange={e => setReason(e.target.value)} /></Field>
        <ReasonChips options={REFUND_REASONS} value={reason} onPick={setReason} />
      </>}
      <DepositTotal collect={collect} quantity={quantity} unitDeposit={unitDeposit} row={row} hasMember={!!owner} error={previewError} />
    </FormDialog>
  );
}

const CONTAINERS: ContainerType[] = ['BUCKET', 'BAG'];
/** What a new refund request may still cover: refundable now, less what is already waiting for review. */
const applicable = (row: DepositSummaryRow) => Math.max(0, row.refundableQty - row.pendingRefundQty);

function DepositTotal({ collect, quantity, unitDeposit, row, hasMember, error }: {
  collect: boolean; quantity: number; unitDeposit?: number; row?: DepositSummaryRow; hasMember: boolean; error: string;
}) {
  if (error) return <p className="account-error" role="alert">{error}</p>;
  if (collect) return (
    <div className="deposit-total">
      <span>应收押金</span>
      <b>{unitDeposit === undefined ? '—' : `¥ ${money(unitDeposit * quantity)}`}</b>
      <small>{unitDeposit === undefined ? '押金标准加载中' : `${quantity} 个 × ¥${money(unitDeposit)}，按现行押金标准收取；交押金不改变持有容器数`}</small>
    </div>
  );
  if (!hasMember) return <div className="deposit-total"><span>预计退还</span><b>—</b><small>请选择会员后查询可退押金</small></div>;
  if (!row) return <div className="deposit-total"><span>预计退还</span><b>—</b><small>正在查询可退押金…</small></div>;
  const available = applicable(row);
  const over = quantity > available;
  // Exact only when nothing else is waiting and the whole refundable quantity is asked back; otherwise the FIFO lots decide at approval.
  const exact = row.pendingRefundQty === 0 && quantity === row.refundableQty;
  return (
    <div className={`deposit-total${over ? ' warn' : ''}`}>
      <span>预计退还</span>
      <b>{available === 0 ? '无可申请数量' : over ? `最多可申请 ${available} 个` : exact ? `¥ ${money(row.refundableAmount)}` : '按原批次单价计算'}</b>
      <small>
        {over
          ? `超出可申请数量：已交未退 ${row.paidQty} 个，持有占用 ${row.heldQty} 个${row.pendingDamageQty ? `，待报废 ${row.pendingDamageQty} 个` : ''}${row.pendingRefundQty ? `，已有 ${row.pendingRefundQty} 个在审核中` : ''}。请先登记归还容器。`
          : '审核通过时按原收款批次单价先进先出计算实退金额，不按现行标准；提交申请不会动押金余额。'}
      </small>
    </div>
  );
}

export function MovementDialog({ memberId, onClose, onDone }: { memberId?: string; onClose: () => void; onDone?: Done }) {
  const { api, can } = useAuth();
  const toast = useToast();
  const key = useIdempotencyKey();
  const [member, setMember] = usePickedMember(memberId);
  const [container, setContainer] = useState<ContainerType>('BUCKET');
  const [fullOut, setFullOut] = useState(0);
  const [emptyIn, setEmptyIn] = useState(1);
  if (!can(P.ContainerRegister) && !can(P.OrderFulfill)) return <UnavailableDialog title="容器领还登记" message="当前账号没有容器登记权限" onClose={onClose} />;
  return (
    <FormDialog title="容器领还登记" submitLabel="确认登记" onClose={onClose} onSubmit={async () => {
      if (!member) throw new Error('请选择会员');
      const result = await api.registerMovement({ memberId: member.id, containerType: container, fullOutN: fullOut, emptyInM: emptyIn, idempotencyKey: key });
      await onDone?.();
      toast(`领还已登记，会员当前持有 ${result.currentHeld} 个`);
    }}>
      <Field label="会员" htmlFor="moveMember"><MemberPicker id="moveMember" value={member} onChange={setMember} /></Field>
      <Field label="容器类型" htmlFor="moveContainer"><select id="moveContainer" className="select" value={container} onChange={e => setContainer(e.target.value as ContainerType)}><ContainerOptions /></select></Field>
      <Field label="满桶领出" htmlFor="moveOut"><input id="moveOut" className="input" type="number" min={0} step={1} required value={fullOut} onChange={e => setFullOut(Number(e.target.value))} /></Field>
      <Field label="空桶收回" htmlFor="moveIn"><input id="moveIn" className="input" type="number" min={0} step={1} required value={emptyIn} onChange={e => setEmptyIn(Number(e.target.value))} /></Field>
      <p className="membership-note">按实际交接登记，同时更新会员持有和水站库存；押金另行结算。</p>
    </FormDialog>
  );
}
