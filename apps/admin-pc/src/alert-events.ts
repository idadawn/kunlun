import type { AdminAlertSnapshot } from '@kunlun/shared';

export type AlertPage = 'orders' | 'refunds';

export interface AdminNotice {
  page: AlertPage;
  text: string;
  keys: string[];
}

// Orders stay on the books when cancelled or completed. Pending reviews can appear and
// disappear in the same poll, so compare their identities instead of their total.
export function newNotices(previous: AdminAlertSnapshot | null, current: AdminAlertSnapshot): AdminNotice[] {
  if (!previous) return [];
  const notices: AdminNotice[] = [];
  const added = current.orderTotal - previous.orderTotal;
  if (added > 0) notices.push({ page: 'orders', text: `收到 ${added} 张新水单`, keys: [`orders:${current.orderTotal}`] });
  const known = new Set(previous.pendingReviewIds);
  const ids = current.pendingReviewIds.filter(id => !known.has(id));
  if (ids.length) notices.push({ page: 'refunds', text: `新增 ${ids.length} 笔待审核申请`, keys: ids });
  return notices;
}
