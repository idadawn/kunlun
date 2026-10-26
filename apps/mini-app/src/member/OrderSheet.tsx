import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { modeLabel, money, pathFor, unitOf, type FulfillMode, type MemberProfile, type WaterType } from '@kunlun/shared';
import { AddressPicker, useAuth, useIdempotencyKey, useToast } from '@kunlun/ui';
import { Sheet } from '../shared/H5Shell';
import { useMemberData } from './data';

const SLOTS = ['尽快送达（约 45 分钟内）', '今天 14:00–16:00', '今天 16:00–18:00'];

export const availableTickets = (p: MemberProfile, water: WaterType, mode: FulfillMode) =>
  mode === 'DELIVERY'
    ? water === 'BAG_7_5L' ? p.bagDeliveryTickets : p.bucketDeliveryTickets
    : water === 'BAG_7_5L' ? p.bagPickupTickets : p.bucketPickupTickets;

/** 预约用水：配送单从会员地址簿选择收货地址，服务端按所选地址保存本单快照。 */
export function OrderSheet({ profile, mode, onClose, onPickupCode }: {
  profile: MemberProfile;
  mode: FulfillMode;
  onClose: () => void;
  onPickupCode: (orderNo: string, code: string) => void;
}) {
  const { api } = useAuth();
  const { products, refresh } = useMemberData();
  const toast = useToast();
  const navigate = useNavigate();
  const key = useIdempotencyKey();
  const [water, setWater] = useState<WaterType>('BUCKET_18_9L');
  const [qty, setQty] = useState(1);
  const [addressId, setAddressId] = useState<string | null>(null);
  const [slot, setSlot] = useState(SLOTS[0]);
  const [remark, setRemark] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const delivery = mode === 'DELIVERY';
  const product = products.find(p => p.waterType === water);
  const minimum = delivery ? product?.deliveryMinimum ?? 1 : 1;
  const quantity = Math.max(minimum, qty);
  const unit = unitOf(water);

  const submit = async () => {
    if (busy) return;
    if (delivery && !addressId) { setError('请先选择或新增收货地址'); return; }
    setBusy(true); setError('');
    try {
      const res = await api.createOrder({
        memberId: profile.id, waterType: water, fulfillMode: mode, orderQty: quantity, idempotencyKey: key,
        addressId: delivery ? addressId : null, appointmentSlot: delivery ? slot : null, remark: remark.trim() || null,
      });
      await refresh();
      if (!delivery && res.pickupCode) onPickupCode(res.orderNo, res.pickupCode);
      else {
        toast(`预约成功！单号 ${res.orderNo}，剩余可用票 ${res.availableTicketsAfter}`);
        onClose();
        navigate(pathFor('member', 'orders'));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Sheet title={delivery ? '预约送水到家' : '预约到店自提'} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>取消</button>
      <button type="button" className="btn primary" disabled={busy || (delivery && !addressId)} onClick={submit}>{busy ? '正在提交…' : '确认提交'}</button>
    </>}>
      <div className="field">
        <label htmlFor="mWaterSel">选择水品（绿麒麟·小分子团弱碱活性水）</label>
        <select id="mWaterSel" className="select" value={water} onChange={e => setWater(e.target.value as WaterType)}>
          {(['BUCKET_18_9L', 'BAG_7_5L'] as const).map(w => (
            <option key={w} value={w}>{products.find(p => p.waterType === w)?.name || (w === 'BAG_7_5L' ? '袋装水' : '桶装水')}（可用 {availableTickets(profile, w, mode)} {unitOf(w)}）</option>
          ))}
        </select>
      </div>
      <div className="qty-row">
        <span>用水数量</span>
        <div className="qty-control">
          <button type="button" aria-label="减少" onClick={() => setQty(Math.max(minimum, quantity - 1))}>−</button>
          <input id="mOrdQty" value={quantity} readOnly aria-label="用水数量" />
          <button type="button" aria-label="增加" onClick={() => setQty(quantity + 1)}>+</button>
        </div>
      </div>
      {delivery ? <>
        <div className="field">
          <label>收货地址（下单后保存为本单快照）</label>
          <AddressPicker owner={{ id: profile.id, name: profile.name, phone: profile.phone }} value={addressId} onChange={setAddressId} />
        </div>
        <div className="field">
          <label htmlFor="mSlot">期望送达时段</label>
          <select id="mSlot" className="select" value={slot} onChange={e => setSlot(e.target.value)}>{SLOTS.map(s => <option key={s}>{s}</option>)}</select>
        </div>
      </> : (
        <div className="field"><label htmlFor="mStore">自提门店</label><input id="mStore" className="input" value="绿麒麟水站（营业时间 08:00–20:00）" readOnly /></div>
      )}
      <div className="field">
        <label htmlFor="mRemark">备注（选填）</label>
        <input id="mRemark" className="input" maxLength={200} placeholder="如：空桶放门口 / 到店自取" value={remark} onChange={e => setRemark(e.target.value)} />
      </div>
      <div style={{ background: 'var(--brand-50)', padding: '10px 12px', borderRadius: 11, fontSize: 12, color: 'var(--brand-700)' }}>
        本次将预占 <b>{modeLabel(mode)}{unit}票 {quantity} {unit}{delivery && product ? `（${product.deliveryFee === 0 ? '免费配送' : `配送费 ¥${money(product.deliveryFee)}`}，${minimum}${unit}起送）` : ''}</b>；交付核销前您可在“待接单”状态随时取消并释放水票。
      </div>
      {error && <p className="account-error" role="alert">{error}</p>}
    </Sheet>
  );
}

export function PickupCodeSheet({ orderNo, code, onClose }: { orderNo: string; code: string; onClose: () => void }) {
  return (
    <Sheet title="到店自提 · 取水凭证" onClose={onClose} footer={<button type="button" className="btn primary" onClick={onClose}>我知道了</button>}>
      <div className="qr-box">
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>请向绿麒麟水站店员出示此取水码</div>
        <div className="qr-code">{code}</div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>关联水单：{orderNo}</div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>店员核验取水码并交付水品后，预占水票将自动核销</div>
    </Sheet>
  );
}
