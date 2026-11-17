import { useState } from 'react';
import {
  KUNLUN_PERMISSIONS as P, calcDepositGap, containerKind, containerOf, containerUnit, money, unitOf, waterFallbackLabel,
  type PayMethod, type WaterOrder,
} from '@kunlun/shared';
import { useAuth } from '../auth';
import { Field, FormDialog, NumberInput, useToast } from '../feedback';
import { useIdempotencyKey } from '../hooks';
import { DepositDue, useDepositPositions } from '../ordering';
import { PayOptions } from './common';

/**
 * Delivery or pickup hand-over. Without an order it verifies a member's six-digit pickup code.
 * Every count and the deposit are for the order's own water and its container: a 5L bag order hands over bags and takes
 * bag deposit, a bucket order buckets, so the labels say which one is moving.
 */
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
  const container = order ? order.productSnapshot?.containerId ?? containerOf(order.waterType) : null;
  // A pickup code alone does not say which water it is for, so its counts name both kinds.
  const unit = container ? containerUnit(container) : '桶/袋';
  const position = container ? deposits.data?.[container] : undefined;
  // Full-for-empty swap: by default collect as many empties as the member holds, up to the quantity delivered.
  const emptyIn = emptyInInput ?? (position ? Math.min(position.held, initial) : initial);
  const gap = position ? calcDepositGap(position.covered, position.held, fullOut, emptyIn) : 0;
  // Empties beyond what the member holds are their own containers swapped in: nothing new is lent out, so no deposit.
  const ownEmpties = position ? Math.max(0, emptyIn - position.held) : 0;
  const submit = async () => {
    if (order && container && !position) throw new Error(deposits.error ? `押金核对失败：${deposits.error}` : '正在核对会员手里的桶袋和押金，请稍候');
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
      {order && container && (
        <p className="fulfill-container">
          <b>{order.productSnapshot?.waterLabel || waterFallbackLabel(order.waterType)} · 配套{containerKind(container) === 'BAG' ? '水袋' : '桶'}</b>
          <small>{position
            ? `押金 ¥${money(position.unitDeposit)}/个 · 会员手里 ${position.held} 个${unit}，押金覆盖 ${Math.max(0, position.covered)} 个`
            : deposits.error ? `押金核对失败：${deposits.error}` : `正在核对会员手里的${unit}和押金…`}</small>
        </p>
      )}
      {order?.remark && <p className="membership-note">备注：{order.remark}</p>}
      {pickup && <Field label="会员出示的六位取水码" htmlFor="pickupCode"><input id="pickupCode" className="input" required pattern="[0-9]{6}" inputMode="numeric" maxLength={6} value={code} onChange={e => setCode(e.target.value)} /></Field>}
      <Field label="实际交付数量" htmlFor="fulfillQty"><NumberInput id="fulfillQty" className="input" inputMode="numeric" min={1} step={1} required value={actual} onChange={setActual} /></Field>
      <Field label={`满${unit}领出`} htmlFor="fullOut"><NumberInput id="fullOut" className="input" inputMode="numeric" min={0} step={1} required value={fullOut} onChange={setFullOut} /></Field>
      <Field label={`空${unit}收回`} htmlFor="emptyIn"><NumberInput id="emptyIn" className="input" inputMode="numeric" min={0} step={1} required value={emptyIn} onChange={setEmptyIn} /></Field>
      {ownEmpties > 0 && position && (
        <p className="membership-note">会员名下只有 {position.held} 个{unit}，多收的 {ownEmpties} 个算会员自带的{unit}换给店里，这 {ownEmpties} 个不用交押金；不是自带的请改回 {position.held}。</p>
      )}
      {container && position && (
        <DepositDue type={container} position={position} fullOut={fullOut} emptyIn={emptyIn}>
          <select className="select" aria-label="押金收款方式" value={payMethod} onChange={e => setPayMethod(e.target.value as PayMethod)}><PayOptions /></select>
        </DepositDue>
      )}
      <Field label="数量不一致时填写原因" htmlFor="diffReason"><input id="diffReason" className="input" maxLength={500} value={diffReason} onChange={e => setDiffReason(e.target.value)} /></Field>
    </FormDialog>
  );
}
