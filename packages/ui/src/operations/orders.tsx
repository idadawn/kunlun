import { useState } from 'react';
import { unitOf, type CreateOrderResult, type FulfillMode, type MemberProfile, type WaterOrder, type WaterProduct, type WaterType } from '@kunlun/shared';
import { AddressPicker } from '../addresses';
import { useApi } from '../auth';
import { Field, FormDialog, useToast } from '../feedback';
import { useIdempotencyKey } from '../hooks';
import { MemberOptions, UnavailableDialog, initialMember } from './common';

export function StaffOrderDialog({ members, products, memberId, onClose, onDone }: {
  members: MemberProfile[];
  products: WaterProduct[];
  memberId?: string;
  onClose: () => void;
  onDone?: (order: CreateOrderResult) => void | Promise<void>;
}) {
  const api = useApi();
  const toast = useToast();
  const key = useIdempotencyKey();
  const [member, setMember] = useState(initialMember(members, memberId));
  const [water, setWater] = useState<WaterType>(products[0]?.waterType ?? 'BUCKET_18_9L');
  const [mode, setMode] = useState<FulfillMode>('PICKUP');
  const [qty, setQty] = useState(1);
  const [addressId, setAddressId] = useState<string | null>(null);

  if (!members.length) return <UnavailableDialog title="代会员开水单" message="请先建立会员档案" onClose={onClose} />;
  const product = products.find(p => p.waterType === water);
  const delivery = mode === 'DELIVERY';
  const minimum = delivery ? product?.deliveryMinimum ?? 1 : 1;
  const owner = members.find(m => m.id === member)!;
  const changeRule = (nextWater: WaterType, nextMode: FulfillMode) => {
    setWater(nextWater); setMode(nextMode);
    const min = nextMode === 'DELIVERY' ? products.find(p => p.waterType === nextWater)?.deliveryMinimum ?? 1 : 1;
    setQty(q => Math.max(q, min));
  };
  const submit = async () => {
    if (delivery && !addressId) throw new Error('配送水单需要收货地址，请为会员选择或新增收货地址');
    const order = await api.createOrder({ memberId: member, waterType: water, fulfillMode: mode, orderQty: qty, idempotencyKey: key, addressId: delivery ? addressId : null });
    await onDone?.(order);
    toast(`水单已创建${order.pickupCode ? '，取水码 ' + order.pickupCode : ''}`);
  };
  return (
    <FormDialog title="代会员开水单" submitLabel="提交并预占水票" onClose={onClose} onSubmit={submit}>
      <Field label="会员" htmlFor="orderMember"><select id="orderMember" className="select" value={member} onChange={e => { setMember(e.target.value); setAddressId(null); }}><MemberOptions members={members} /></select></Field>
      <Field label="水品" htmlFor="orderWater">
        <select id="orderWater" className="select" value={water} onChange={e => changeRule(e.target.value as WaterType, mode)}>
          {products.map(p => <option key={p.waterType} value={p.waterType}>{p.name}</option>)}
        </select>
      </Field>
      <Field label="领取方式" htmlFor="orderMode">
        <select id="orderMode" className="select" value={mode} onChange={e => changeRule(water, e.target.value as FulfillMode)}>
          <option value="PICKUP">自提</option><option value="DELIVERY">配送</option>
        </select>
      </Field>
      <Field label="数量" htmlFor="orderQty"><input id="orderQty" className="input" type="number" min={minimum} step={1} required value={qty} onChange={e => setQty(Number(e.target.value))} /></Field>
      <p className="membership-note">{delivery ? `免费配送，${minimum}${unitOf(water)}起送` : '门店自提'}</p>
      {delivery && <>
        <label>收货地址</label>
        <AddressPicker key={owner.id} owner={owner} value={addressId} onChange={setAddressId} />
      </>}
    </FormDialog>
  );
}

/** Delivery or pickup hand-over. Without an order it verifies a member's six-digit pickup code. */
export function FulfillDialog({ order, onClose, onDone }: { order?: WaterOrder; onClose: () => void; onDone?: () => void | Promise<void> }) {
  const api = useApi();
  const toast = useToast();
  const pickup = !order || order.fulfillMode === 'PICKUP';
  const initial = order?.orderQty ?? 1;
  const [code, setCode] = useState('');
  const [actual, setActual] = useState(initial);
  const [fullOut, setFullOut] = useState(initial);
  const [emptyIn, setEmptyIn] = useState(initial);
  const [diffReason, setDiffReason] = useState('');
  const submit = async () => {
    const body = { actualQty: actual, fullOutN: fullOut, emptyInM: emptyIn, pickupCode: code || null, diffReason: diffReason || null };
    if (order) await api.fulfillOrder(order.id, body);
    else await api.verifyPickup({ ...body, pickupCode: code });
    await onDone?.();
    toast('交付成功，已按批次扣除水票');
  };
  return (
    <FormDialog title={pickup ? '自提核销' : '确认配送交付'} submitLabel="确认交付并扣票" onClose={onClose} onSubmit={submit}>
      {order && <p>{order.orderNo} · 下单 {order.orderQty}{unitOf(order.waterType)}{!pickup && order.addressSnapshot?.address ? ` · ${order.addressSnapshot.address}` : ''}</p>}
      {order?.remark && <p className="membership-note">备注：{order.remark}</p>}
      {pickup && <Field label="会员出示的六位取水码" htmlFor="pickupCode"><input id="pickupCode" className="input" required pattern="[0-9]{6}" inputMode="numeric" maxLength={6} value={code} onChange={e => setCode(e.target.value)} /></Field>}
      <Field label="实际交付数量" htmlFor="fulfillQty"><input id="fulfillQty" className="input" type="number" min={1} step={1} required value={actual} onChange={e => setActual(Number(e.target.value))} /></Field>
      <Field label="满桶领出" htmlFor="fullOut"><input id="fullOut" className="input" type="number" min={0} step={1} required value={fullOut} onChange={e => setFullOut(Number(e.target.value))} /></Field>
      <Field label="空桶收回" htmlFor="emptyIn"><input id="emptyIn" className="input" type="number" min={0} step={1} required value={emptyIn} onChange={e => setEmptyIn(Number(e.target.value))} /></Field>
      <Field label="数量不一致时填写原因" htmlFor="diffReason"><input id="diffReason" className="input" maxLength={500} value={diffReason} onChange={e => setDiffReason(e.target.value)} /></Field>
    </FormDialog>
  );
}
