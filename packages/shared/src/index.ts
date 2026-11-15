import type { AuthSession, CurrentUser } from './types';
import type { PermissionCode } from './permissions';

export * from './types';
export * from './api';
export * from './routes';
export * from './format';
export * from './paging';
export * from './plans';
export * from './price-poster';
export * from './permissions';
export * from './mobile';

export const KUNLUN_BRAND = {
  brand: '绿麒麟',
  store: '绿麒麟水站',
  product: '小分子团弱碱活性水',
  system: '绿麒麟·水站会员管理系统',
  signage: '绿麒麟水站｜小分子团弱碱活性水',
  slogan: '鲜活每一滴，好水到你家',
} as const;

/** UI hint only: the server re-checks every permission on each request. */
export function hasPermission(session: Pick<AuthSession | CurrentUser, 'subjectType' | 'permissions'> | null | undefined, perm: PermissionCode): boolean {
  return !!session && session.subjectType === 'STAFF' && session.permissions.includes(perm);
}

/** 会员持有变化 = 满桶领出 N - 空桶收回 M */
export function calcHoldingDelta(fullOutN: number, emptyInM: number): number {
  return fullOutN - emptyInM;
}

/** 可退押金个数 = max(0, 已交未退押金个数 - 当前实际持有个数) */
export function calcRefundableDepositQty(paidRemainingQty: number, heldQty: number): number {
  return Math.max(0, paidRemainingQty - heldQty);
}

/**
 * 需补押金个数 = max(0, 交付后持有 - 押金覆盖个数)，交付后持有 = 当前持有 + 满桶领出 N - 空桶收回 M。
 * 押金覆盖个数 = 已交未退 - 待报废占用，与交付时服务端校验一致。
 */
export function calcDepositGap(coveredQty: number, heldQty: number, fullOutN: number, emptyInM: number): number {
  return Math.max(0, heldQty + calcHoldingDelta(fullOutN, emptyInM) - coveredQty);
}
