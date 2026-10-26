export const KUNLUN_BRAND = {
  brand: '绿麒麟',
  store: '绿麒麟水站',
  product: '小分子团弱碱活性水',
  system: '绿麒麟·水站会员管理系统',
  signage: '绿麒麟水站｜小分子团弱碱活性水',
  slogan: '鲜活每一滴，好水到你家',
} as const;

export type WaterType = 'BUCKET_18_9L' | 'BAG_7_5L';
export type FulfillMode = 'DELIVERY' | 'PICKUP';
export type RoleCode = 'ADMIN' | 'CLERK' | 'COURIER' | 'MEMBER';

/** 会员持有变化 = 满桶领出 N - 空桶收回 M */
export function calcHoldingDelta(fullOutN: number, emptyInM: number): number {
  return fullOutN - emptyInM;
}

/** 可退押金个数 = max(0, 已交未退押金个数 - 当前实际持有个数) */
export function calcRefundableDepositQty(paidRemainingQty: number, heldQty: number): number {
  return Math.max(0, paidRemainingQty - heldQty);
}
