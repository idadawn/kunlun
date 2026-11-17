import { useState } from 'react';
import {
  KUNLUN_PERMISSIONS as P, calcDepositGap, containerOf, containerUnit, money, unitOf, waterFallbackLabel,
  type FulfillOrderRequest, type PayMethod, type WaterOrder,
} from '@kunlun/shared';
import { useAuth } from '../auth';
import { Field, FormDialog, NumberInput, useToast } from '../feedback';
import { useIdempotencyKey } from '../hooks';
import {
  DEPOSIT_NOT_RECEIVED, DepositSettle, EMPTY_OWED_NOTE, OwedNoteFields, composeOwedNote, owedNoteProblem, useConfirmDepositReceived, useDepositPositions,
  type OwedNote,
} from '../ordering';
import { PayOptions } from './common';

/**
 * Delivery or pickup hand-over. Without an order it verifies a member's six-digit pickup code.
 * 押金不够时写应付、实付、欠押金：实付默认收齐，顾客没给够就往下调，差额记欠押金并必须写备注。
 */
export function FulfillDialog({ order, onClose, onDone }: { order?: WaterOrder; onClose: () => void; onDone?: () => void | Promise<void> }) {
  const { api, can } = useAuth();
  const toast = useToast();
  const key = useIdempotencyKey();
  const deposits = useDepositPositions(order?.memberId);
  const confirmDeposit = useConfirmDepositReceived();
  const [payMethod, setPayMethod] = useState<PayMethod>('WECHAT');
  const pickup = !order || order.fulfillMode === 'PICKUP';
  const initial = order?.orderQty ?? 1;
  const [code, setCode] = useState('');
  const [actual, setActual] = useState(initial);
  const [fullOut, setFullOut] = useState(initial);
  const [emptyInInput, setEmptyIn] = useState<number | null>(null);
  const [diffReason, setDiffReason] = useState('');
  // Containers the customer did not pay a deposit for; 实付 follows 应付 until the courier lowers it.
  const [unpaid, setUnpaid] = useState(0);
  const [owedNote, setOwedNote] = useState<OwedNote>(EMPTY_OWED_NOTE);
  const container = order ? order.productSnapshot?.containerId ?? containerOf(order.waterType) : null;
  const position = container ? deposits.data?.[container] : undefined;
  // Full-for-empty swap: by default collect as many empties as the member holds, up to the quantity delivered.
  const emptyIn = emptyInInput ?? (position ? Math.min(position.held, initial) : initial);
  const gap = position ? calcDepositGap(position.covered, position.held, fullOut, emptyIn) : 0;
  const paid = gap - Math.min(unpaid, gap);
  const owed = gap - paid;
  const unit = container ? containerUnit(container) : '桶';
  const submit = async () => {
    const body: FulfillOrderRequest = { actualQty: actual, fullOutN: fullOut, emptyInM: emptyIn, pickupCode: code || null, diffReason: diffReason || null };
    if (order && container && position && gap > 0) {
      if (!can(P.DepositCollect)) throw new Error('交付后押金不足，当前账号没有收押金权限');
      const problem = owed > 0 ? owedNoteProblem(owedNote) : '';
      if (problem) throw new Error(problem);
      const price = position.unitDeposit;
      if (paid > 0) {
        const name = order.productSnapshot?.waterLabel || waterFallbackLabel(order.waterType);
        const unpaidPart = owed > 0 ? { amount: owed * price, text: `${owed} 个${unit}` } : undefined;
        if (!await confirmDeposit(payMethod, [{ name, type: container, qty: paid, unitDeposit: price }], unpaidPart)) throw new Error(DEPOSIT_NOT_RECEIVED);
        // Keyed by the amount and method so a retry after a later failure cannot charge twice; coverage is re-read afterwards,
        // which leaves only the unpaid part as 应付 (and 实付 at zero) if the hand-over itself has to be retried.
        await api.collectDeposit({ memberId: order.memberId, containerType: container, quantity: paid, payMethod, idempotencyKey: `${key}:${paid}:${payMethod}` });
        await deposits.reload();
      }
      if (owed > 0) Object.assign(body, { forceCreditOverride: true, overrideReason: composeOwedNote(owedNote, `${owed} 个${unit} ¥${money(owed * price)}`, unit) });
    }
    if (order) await api.fulfillOrder(order.id, body);
    else await api.verifyPickup({ ...body, pickupCode: code });
    await onDone?.();
    toast('交付成功，已按批次扣除水票');
  };
  return (
    <FormDialog title={pickup ? '自提核销' : '确认配送交付'} submitLabel={gap > 0 ? paid > 0 ? '收押金并交付' : '记欠押金并交付' : '确认交付并扣票'} onClose={onClose} onSubmit={submit}>
      {order && <p>{order.orderNo} · 下单 {order.orderQty}{unitOf(order.waterType)}{!pickup && order.addressSnapshot?.address ? ` · ${order.addressSnapshot.address}` : ''}</p>}
      {order?.remark && <p className="membership-note">备注：{order.remark}</p>}
      {pickup && <Field label="会员出示的六位取水码" htmlFor="pickupCode"><input id="pickupCode" className="input" required pattern="[0-9]{6}" inputMode="numeric" maxLength={6} value={code} onChange={e => setCode(e.target.value)} /></Field>}
      <Field label="实际交付数量" htmlFor="fulfillQty"><NumberInput id="fulfillQty" className="input" inputMode="numeric" min={1} step={1} required value={actual} onChange={setActual} /></Field>
      <Field label="满桶领出" htmlFor="fullOut"><NumberInput id="fullOut" className="input" inputMode="numeric" min={0} step={1} required value={fullOut} onChange={setFullOut} /></Field>
      <Field label="空桶收回" htmlFor="emptyIn"><NumberInput id="emptyIn" className="input" inputMode="numeric" min={0} step={1} required value={emptyIn} onChange={setEmptyIn} /></Field>
      {container && position && (
        <DepositSettle type={container} position={position} fullOut={fullOut} emptyIn={emptyIn} paid={paid} onPaidChange={v => setUnpaid(gap - v)}>
          <select className="select" aria-label="押金收款方式" value={payMethod} onChange={e => setPayMethod(e.target.value as PayMethod)}><PayOptions /></select>
        </DepositSettle>
      )}
      {owed > 0 && <OwedNoteFields id="fulfillOwedNote" value={owedNote} onChange={setOwedNote} unit={unit} />}
      <Field label="数量不一致时填写原因" htmlFor="diffReason"><input id="diffReason" className="input" maxLength={500} value={diffReason} onChange={e => setDiffReason(e.target.value)} /></Field>
    </FormDialog>
  );
}
