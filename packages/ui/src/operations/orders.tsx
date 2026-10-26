import { useState } from 'react';
import { KUNLUN_PERMISSIONS as P, calcDepositGap, containerOf, unitOf, type PayMethod, type WaterOrder } from '@kunlun/shared';
import { useAuth } from '../auth';
import { Field, FormDialog, useToast } from '../feedback';
import { useIdempotencyKey } from '../hooks';
import { DepositDue, useDepositPositions } from '../ordering';
import { PayOptions } from './common';

/** Delivery or pickup hand-over. Without an order it verifies a member's six-digit pickup code. */
export function FulfillDialog({ order, onClose, onDone }: { order?: WaterOrder; onClose: () => void; onDone?: () => void | Promise<void> }) {
  const { api, can } = useAuth();
  const toast = useToast();
  const key = useIdempotencyKey();
  const deposits = useDepositPositions(order?.memberId);
  const [payMethod, setPayMethod] = useState<PayMethod>('WECHAT');
  const pickup = !order || order.fulfillMode === 'PICKUP';
  const initial = order?.orderQty ?? 1;
  const [code, setCode] = useState('');
  const [actual, setActual] = useState(initial);
  const [fullOut, setFullOut] = useState(initial);
  const [emptyInInput, setEmptyIn] = useState<number | null>(null);
  const [diffReason, setDiffReason] = useState('');
  const container = order ? containerOf(order.waterType) : null;
  const position = container ? deposits.data?.[container] : undefined;
  // Full-for-empty swap: by default collect as many empties as the member holds, up to the quantity delivered.
  const emptyIn = emptyInInput ?? (position ? Math.min(position.held, initial) : initial);
  const gap = position ? calcDepositGap(position.covered, position.held, fullOut, emptyIn) : 0;
  const submit = async () => {
    const body = { actualQty: actual, fullOutN: fullOut, emptyInM: emptyIn, pickupCode: code || null, diffReason: diffReason || null };
    if (order && container && gap > 0) {
      if (!can(P.DepositCollect)) throw new Error('交付后押金不足，当前账号没有收押金权限');
      // Keyed by the amount and method so a retry after a later failure cannot charge twice; coverage is re-read afterwards.
      await api.collectDeposit({ memberId: order.memberId, containerType: container, quantity: gap, payMethod, idempotencyKey: `${key}:${gap}:${payMethod}` });
      await deposits.reload();
    }
    if (order) await api.fulfillOrder(order.id, body);
    else await api.verifyPickup({ ...body, pickupCode: code });
    await onDone?.();
    toast('交付成功，已按批次扣除水票');
  };
  return (
    <FormDialog title={pickup ? '自提核销' : '确认配送交付'} submitLabel={gap > 0 ? '收押金并交付' : '确认交付并扣票'} onClose={onClose} onSubmit={submit}>
      {order && <p>{order.orderNo} · 下单 {order.orderQty}{unitOf(order.waterType)}{!pickup && order.addressSnapshot?.address ? ` · ${order.addressSnapshot.address}` : ''}</p>}
      {pickup && <Field label="会员出示的六位取水码" htmlFor="pickupCode"><input id="pickupCode" className="input" required pattern="[0-9]{6}" inputMode="numeric" maxLength={6} value={code} onChange={e => setCode(e.target.value)} /></Field>}
      <Field label="实际交付数量" htmlFor="fulfillQty"><input id="fulfillQty" className="input" type="number" min={1} step={1} required value={actual} onChange={e => setActual(Number(e.target.value))} /></Field>
      <Field label="满桶领出" htmlFor="fullOut"><input id="fullOut" className="input" type="number" min={0} step={1} required value={fullOut} onChange={e => setFullOut(Number(e.target.value))} /></Field>
      <Field label="空桶收回" htmlFor="emptyIn"><input id="emptyIn" className="input" type="number" min={0} step={1} required value={emptyIn} onChange={e => setEmptyIn(Number(e.target.value))} /></Field>
      {container && position && (
        <DepositDue type={container} position={position} fullOut={fullOut} emptyIn={emptyIn}>
          <select className="select" aria-label="押金收款方式" value={payMethod} onChange={e => setPayMethod(e.target.value as PayMethod)}><PayOptions /></select>
        </DepositDue>
      )}
      <Field label="数量不一致时填写原因" htmlFor="diffReason"><input id="diffReason" className="input" maxLength={500} value={diffReason} onChange={e => setDiffReason(e.target.value)} /></Field>
    </FormDialog>
  );
}
