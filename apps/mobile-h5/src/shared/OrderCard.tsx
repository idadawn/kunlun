import type { ReactNode } from 'react';
import { isActiveOrder, orderStatusLabel, waterFallbackLabel, type WaterOrder } from '@kunlun/shared';
import { Icon } from '@kunlun/ui';

/** H5 water order card. Staff see the delivery contact from the order's address snapshot. */
export function OrderCard({ order, title, showContact = false, actions }: { order: WaterOrder; title: string; showContact?: boolean; actions?: ReactNode }) {
  const active = isActiveOrder(order);
  const snapshot = order.addressSnapshot;
  const delivery = order.fulfillMode === 'DELIVERY';
  return (
    <div className="h5-order">
      <div className="h5-order-top">
        <div><b>{title}</b><small>{order.orderNo}</small></div>
        <span className={`tag ${active ? 'orange' : 'gray'}`}>{orderStatusLabel(order)}</span>
      </div>
      <div className="h5-product">
        <div>
          <b>{order.productSnapshot?.waterLabel || waterFallbackLabel(order.waterType)} × {order.orderQty}</b>
          <small>{delivery ? snapshot?.address || '未设置配送地址' : '到店自提'}</small>
        </div>
      </div>
      {showContact && delivery && snapshot?.contactPhone && (
        <div className="h5-address"><Icon name="phone" />收货人 {snapshot.contactName} <a href={`tel:${snapshot.contactPhone}`}>{snapshot.contactPhone}</a></div>
      )}
      {order.remark && <div className="h5-address">备注：{order.remark}</div>}
      <div className="h5-order-foot">
        <small>{active ? `预占 ${order.reservedQty} 张` : `实取 ${order.actualQty || 0} 张`}</small>
        {actions && <div className="membership-actions">{actions}</div>}
      </div>
    </div>
  );
}
