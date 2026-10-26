import type { AuthSession, CurrentUser } from './types';

export * from './types';
export * from './api';
export * from './routes';
export * from './format';
export * from './paging';
export * from './plans';
export * from './price-poster';

export const KUNLUN_BRAND = {
  brand: '绿麒麟',
  store: '绿麒麟水站',
  product: '小分子团弱碱活性水',
  system: '绿麒麟·水站会员管理系统',
  signage: '绿麒麟水站｜小分子团弱碱活性水',
  slogan: '鲜活每一滴，好水到你家',
} as const;

export const KUNLUN_PERMISSIONS = {
  MemberRead: 'kunlun.waterstation:member:read',
  MemberWrite: 'kunlun.waterstation:member:write',
  RechargeCreate: 'kunlun.waterstation:recharge:create',
  RechargeRefund: 'kunlun.waterstation:recharge:refund',
  DepositCollect: 'kunlun.waterstation:deposit:collect',
  DepositRefundApply: 'kunlun.waterstation:deposit:refund_apply',
  DepositRefundApprove: 'kunlun.waterstation:deposit:refund_approve',
  OrderCreate: 'kunlun.waterstation:order:create',
  OrderAccept: 'kunlun.waterstation:order:accept',
  OrderFulfill: 'kunlun.waterstation:order:fulfill',
  PickupVerify: 'kunlun.waterstation:pickup:verify',
  ContainerRegister: 'kunlun.waterstation:container:register',
  ContainerInventoryManage: 'kunlun.waterstation:container:inventory_manage',
  PlanManage: 'kunlun.waterstation:plan:manage',
  ReportExport: 'kunlun.waterstation:report:export',
  StaffManage: 'kunlun.waterstation:staff:manage',
} as const;

export type PermissionCode = (typeof KUNLUN_PERMISSIONS)[keyof typeof KUNLUN_PERMISSIONS];

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
