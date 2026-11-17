import { useState } from 'react';
import { KUNLUN_PERMISSIONS as P, containerKind, containerLabel, containerUnit, money, type ContainerType, type PayMethod } from '@kunlun/shared';
import { useAuth } from '../auth';
import { Field, FormDialog, useToast } from '../feedback';
import { useLoader, useIdempotencyKey } from '../hooks';
import { Icon } from '../icons';
import { Stepper } from '../ordering';
import { MemberPicker, PayButtons, ReasonChips, UnavailableDialog, parseYuan, usePickedMember, useReviewSettings, waitsForReview, type Done } from './common';

export type DepositAction = 'collect' | 'refund';

const REFUND_REASONS = ['不再订水', '搬家', '容器已全部归还', '退回多交押金'] as const;

export function DepositDialog({ memberId, action: initialAction, onClose, onDone }: {
  memberId?: string; action?: DepositAction; onClose: () => void; onDone?: Done;
}) {
  const { api, can } = useAuth();
  const toast = useToast();
  const key = useIdempotencyKey();
  const review = useReviewSettings();
  const canCollect = can(P.DepositCollect);
  const canRefund = can(P.DepositRefundApprove) || can(P.DepositRefundApply);
  const waits = waitsForReview(review, 'refund', can(P.DepositRefundApprove));
  const collectWaits = waitsForReview(review, 'deposit');
  const [member, setMember] = usePickedMember(memberId);
  const [action, setAction] = useState<DepositAction>(initialAction === 'refund' && canRefund || !canCollect ? 'refund' : 'collect');
  const [amount, setAmount] = useState('');
  const [pay, setPay] = useState<PayMethod>('CASH');
  const [reason, setReason] = useState('');
  const summary = useLoader(async () => member ? { id: member.id, rows: await api.depositSummary(member.id) } : null, [api, member?.id]);
  const pool = member && summary.data?.id === member.id ? summary.data.rows[0]?.pool : undefined;
  const collect = action === 'collect';
  const value = parseYuan(amount);
  if (!canCollect && !canRefund) return <UnavailableDialog title="押金办理" message="当前账号没有押金办理权限" onClose={onClose} />;
  const submit = async () => {
    if (!member) throw new Error('请选择会员');
    if (value === null || value <= 0) throw new Error('请输入大于零的金额，最多两位小数');
    const body = { memberId: member.id, amount: value, payMethod: pay, idempotencyKey: key };
    if (!collect && pool && value > pool.available) throw new Error(`当前可退 ¥${money(pool.available)}`);
    const result = collect ? await api.collectDeposit(body) : await api.applyRefund({ ...body, kind: 'DEPOSIT', reason: reason.trim() });
    await onDone?.();
    toast(result.status === 'PENDING' ? `已登记 ¥${money(value)}，等待审核` : `已${collect ? '收' : '退'}押金 ¥${money(value)}`);
  };
  const refundLabel = waits ? '申请退押金' : '退押金';
  return (
    <FormDialog title={collect ? '收押金' : refundLabel}
      description={collect ? `押金单独记账：不算水费，也不送水${collectWaits ? '；收了先记待审核，管理员核对到账后入账' : ''}` : waits ? '提交后由管理员审核，审核通过才退款' : '按实退金额从会员押金余额中扣减'}
      submitLabel={collect ? (value ? `确认已收 ¥${money(value)}` : '确认已收款') : waits ? '提交退款申请' : value !== null ? `确认已退 ¥${money(value)}` : '确认已退款'} onClose={onClose} onSubmit={submit}>
      {canCollect && canRefund && (
        <div className="seg-switch" role="group" aria-label="押金业务">
          {(['collect', 'refund'] as const).map(a => (
            <button key={a} type="button" aria-pressed={action === a} onClick={() => { setAction(a); setAmount(''); }}>{a === 'collect' ? '收押金' : refundLabel}</button>
          ))}
        </div>
      )}
      <Field label="会员" htmlFor="depositMember"><MemberPicker id="depositMember" value={member} onChange={m => { setMember(m); setAmount(''); }} /></Field>
      {summary.error && <p role="alert">{summary.error}</p>}
      {pool && <p className="membership-note">押金余额 ¥{money(pool.total)} · 可退 ¥{money(pool.available)}{pool.pending > 0 && ` · 退款审核中 ¥${money(pool.pending)}`}</p>}
      <Field label={collect ? '收押金金额（元）' : '退押金金额（元）'} htmlFor="depositAmount">
        <input id="depositAmount" className="input deposit-amount" type="number" inputMode="decimal" required min="0.01" step="0.01"
          placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} />
      </Field>
      <label id="depositPayLabel">{collect ? '收款方式' : '退款方式'}</label>
      <PayButtons labelledBy="depositPayLabel" value={pay} onChange={setPay} />
      {!collect && <>
        <Field label="退款原因（选填）" htmlFor="depositReason"><input id="depositReason" className="input" maxLength={500} placeholder="如：不再订水" value={reason} onChange={e => setReason(e.target.value)} /></Field>
        <ReasonChips options={REFUND_REASONS} value={reason} onPick={setReason} />
      </>}
    </FormDialog>
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
        <small>{after !== null && after < 0 ? `还回的比会员手里的多，请核对数量` : '同时更新店里库存，押金另行收退。'}</small>
      </div>
    </FormDialog>
  );
}
