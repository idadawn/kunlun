import { useEffect, useState } from 'react';
import { KUNLUN_PERMISSIONS as P, money, type ContainerSummaryItem, type ContainerType, type DepositSummaryRow, type PayMethod } from '@kunlun/shared';
import { useAuth } from '../auth';
import { Field, FormDialog, useToast } from '../feedback';
import { useIdempotencyKey } from '../hooks';
import { MemberPicker, PayOptions, UnavailableDialog, errorText, usePickedMember, type Done } from './common';

const ContainerOptions = () => <><option value="BUCKET">15L 周转桶</option><option value="BAG">5L 周转水袋</option></>;

export function DepositDialog({ containers, memberId, onClose, onDone }: { containers: ContainerSummaryItem[]; memberId?: string; onClose: () => void; onDone?: Done }) {
  const { api, can } = useAuth();
  const toast = useToast();
  const key = useIdempotencyKey();
  const canCollect = can(P.DepositCollect);
  const canRefund = can(P.DepositRefundApprove) || can(P.DepositRefundApply);
  const [member, setMember] = usePickedMember(memberId);
  const [container, setContainer] = useState<ContainerType>('BUCKET');
  const [action, setAction] = useState<'collect' | 'refund'>(canCollect ? 'collect' : 'refund');
  const [quantity, setQuantity] = useState(1);
  const [pay, setPay] = useState<PayMethod>('CASH');
  const [summary, setSummary] = useState<DepositSummaryRow[] | null>(null);
  const [previewError, setPreviewError] = useState('');

  const owner = member?.id;
  useEffect(() => {
    let alive = true;
    setSummary(null);
    if (owner) api.depositSummary(owner)
      .then(rows => { if (alive) { setSummary(rows); setPreviewError(''); } })
      .catch(e => { if (alive) setPreviewError(errorText(e)); });
    return () => { alive = false; };
  }, [api, owner]);

  if (!canCollect && !canRefund) return <UnavailableDialog title="押金收退登记" message="当前账号没有押金办理权限" onClose={onClose} />;

  const row = summary?.find(r => r.containerType === container);
  const cfg = containers.find(c => c.containerType === container);
  const preview = previewError || (action === 'collect'
    ? (cfg ? `当前单价 ¥${money(cfg.unitDeposit)} / 个；本次应收 ¥${money(cfg.unitDeposit * quantity)}` : '押金标准加载中')
    : !owner ? '请选择会员' : row ? `已交未退 ${row.paidQty} 个，持有 ${row.heldQty} 个，待报废 ${row.pendingDamageQty} 个，最多可退 ${row.refundableQty} 个；退清可退押金 ¥${money(row.refundableAmount)}，退款按原收款单价计算。` : '正在查询可退押金…');
  const submit = async () => {
    if (!member) throw new Error('请选择会员');
    const body = { memberId: member.id, containerType: container, quantity, payMethod: pay, idempotencyKey: key };
    const amount = action === 'collect' ? (await api.collectDeposit(body)).totalAmount : (await api.refundDeposit(body)).refundAmount;
    await onDone?.();
    toast(`押金登记成功：¥${money(amount)}`);
  };
  return (
    <FormDialog title="押金收退登记" submitLabel="确认线下已收付并登记" onClose={onClose} onSubmit={submit}>
      <Field label="会员" htmlFor="depositMember"><MemberPicker id="depositMember" value={member} onChange={setMember} /></Field>
      <Field label="容器" htmlFor="depositContainer"><select id="depositContainer" className="select" value={container} onChange={e => setContainer(e.target.value as ContainerType)}><ContainerOptions /></select></Field>
      <Field label="业务类型" htmlFor="depositAction">
        <select id="depositAction" className="select" value={action} onChange={e => setAction(e.target.value as 'collect' | 'refund')}>
          {canCollect && <option value="collect">收取押金</option>}
          {canRefund && <option value="refund">退还押金</option>}
        </select>
      </Field>
      <Field label="数量" htmlFor="depositQuantity"><input id="depositQuantity" className="input" type="number" min={1} step={1} required value={quantity} onChange={e => setQuantity(Number(e.target.value))} /></Field>
      <Field label="实际收付方式" htmlFor="depositPayment"><select id="depositPayment" className="select" value={pay} onChange={e => setPay(e.target.value as PayMethod)}><PayOptions /></select></Field>
      <div className="membership-summary">{preview}</div>
    </FormDialog>
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
