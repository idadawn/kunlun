import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  KUNLUN_PERMISSIONS as P, pathFor, shortDateTime, unitOf, waterFallbackLabel, type WaterOrder,
} from '@kunlun/shared';
import { Dialog, Field, FulfillDialog, MemberPicker, useAuth, useLoader, usePickedMember } from '@kunlun/ui';
import { useMobileLayout, useStaffData } from './data';

/** Identify the customer before choosing an existing pickup or opening the counter for a walk-in. */
export function StaffPickupDialog({ order, memberId, onClose }: { order?: WaterOrder; memberId?: string; onClose: () => void }) {
  const { can } = useAuth();
  const { refresh } = useStaffData();
  const [byCode, setByCode] = useState(false);
  if (byCode || !can(P.MemberRead)) return <FulfillDialog order={order} onClose={onClose} onDone={refresh} />;
  return <MemberPickup order={order} memberId={memberId} onClose={onClose} useCode={() => setByCode(true)} />;
}

function MemberPickup({ order, memberId, onClose, useCode }: {
  order?: WaterOrder; memberId?: string; onClose: () => void; useCode: () => void;
}) {
  const { can } = useAuth();
  const layout = useMobileLayout();
  const { refresh, setSelectedMemberId } = useStaffData();
  const navigate = useNavigate();
  const [member, setMember] = usePickedMember(order?.memberId ?? memberId);
  const [selectedOrder, setSelectedOrder] = useState<WaterOrder>();
  const target = order ?? selectedOrder;
  if (member && target?.memberId === member.id)
    return <FulfillDialog order={target} pickupMember={member} onClose={onClose} onDone={refresh} />;

  const walkIn = member && layout.has('order') && can(P.OrderCreate) && can(P.OrderFulfill) ? () => {
    setSelectedMemberId(member.id);
    onClose();
    navigate(pathFor('staff', 'order'));
  } : undefined;
  return <Dialog title="自提核销" onClose={onClose}
    footer={<button type="button" className="btn" onClick={useCode}>使用六位取水码</button>}>
    <div className="membership-fields">
      <Field label="取水会员" htmlFor="pickupMember">
        <MemberPicker id="pickupMember" value={member} onChange={setMember} />
      </Field>
      {order && member && <p className="account-error" role="alert">这张水单不属于当前会员，请核对会员。</p>}
      {!order && member && <PendingPickups key={member.id} memberId={member.id} onPick={setSelectedOrder} onWalkIn={walkIn} />}
    </div>
  </Dialog>;
}

function PendingPickups({ memberId, onPick, onWalkIn }: {
  memberId: string; onPick: (order: WaterOrder) => void; onWalkIn?: () => void;
}) {
  const { api } = useAuth();
  const [page, setPage] = useState(1);
  const { data, error, reload } = useLoader(() => api.ordersPage({ memberId, mode: 'PICKUP', status: 'PENDING', page, pageSize: 10 }), [api, memberId, page]);
  if (error) return <div role="alert">{error} <button type="button" className="btn sm" onClick={reload}>重试</button></div>;
  if (!data || data.page !== page) return <p className="membership-note">正在查找待自提水单…</p>;
  if (data.total === 0) return <>
    <p className="membership-note">该会员没有待自提水单。{onWalkIn ? '现场取水可选择水品和数量，确认交付后扣自提票。' : '现场开单请找有门店点单权限的员工。'}</p>
    {onWalkIn && <button type="button" className="btn primary" onClick={onWalkIn}>现场取水</button>}
  </>;
  return <>
    <b>选择待自提水单（{data.total}）</b>
    {data.rows.map(o => <button key={o.id} type="button" className="counter-customer pick" onClick={() => onPick(o)}>
      <span><b>{o.productSnapshot?.waterLabel || waterFallbackLabel(o.waterType)} × {o.orderQty}{unitOf(o.waterType)}</b><br />
        <small>{o.orderNo} · {shortDateTime(o.createdAt)}</small></span>
    </button>)}
    {data.total > data.pageSize && <div className="membership-actions">
      <button type="button" className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
      <button type="button" className="btn sm" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>下一页</button>
    </div>}
  </>;
}
