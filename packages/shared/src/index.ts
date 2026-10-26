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
export type SubjectType = 'STAFF' | 'MEMBER';

export const KUNLUN_PERMISSIONS = {
  MemberRead: 'kunlun.waterstation:member:read',
  MemberWrite: 'kunlun.waterstation:member:write',
  RechargeCreate: 'kunlun.waterstation:recharge:create',
  DepositCollect: 'kunlun.waterstation:deposit:collect',
  DepositRefundApply: 'kunlun.waterstation:deposit:refund_apply',
  DepositRefundApprove: 'kunlun.waterstation:deposit:refund_approve',
  OrderCreate: 'kunlun.waterstation:order:create',
  OrderAccept: 'kunlun.waterstation:order:accept',
  OrderFulfill: 'kunlun.waterstation:order:fulfill',
  PickupVerify: 'kunlun.waterstation:pickup:verify',
  ContainerRegister: 'kunlun.waterstation:container:register',
  PlanManage: 'kunlun.waterstation:plan:manage',
  ReportExport: 'kunlun.waterstation:report:export',
  StaffManage: 'kunlun.waterstation:staff:manage',
} as const;

export type PermissionCode = (typeof KUNLUN_PERMISSIONS)[keyof typeof KUNLUN_PERMISSIONS];

export interface AuthSession {
  accessToken: string;
  subjectType: SubjectType;
  subjectId: string;
  displayName: string;
  codeOrNo: string;
  phone: string;
  role: RoleCode;
  permissions: string[];
  tokenVersion: number;
  isNewMember?: boolean;
}

export function hasPermission(session: AuthSession | null | undefined, perm: PermissionCode): boolean {
  if (!session || session.subjectType !== 'STAFF') return false;
  if (session.role === 'ADMIN' || session.permissions.includes('kunlun.waterstation:*')) return true;
  return session.permissions.includes(perm);
}

/** 会员持有变化 = 满桶领出 N - 空桶收回 M */
export function calcHoldingDelta(fullOutN: number, emptyInM: number): number {
  return fullOutN - emptyInM;
}

/** 可退押金个数 = max(0, 已交未退押金个数 - 当前实际持有个数) */
export function calcRefundableDepositQty(paidRemainingQty: number, heldQty: number): number {
  return Math.max(0, paidRemainingQty - heldQty);
}

export class KunlunAuthClient {
  constructor(private readonly baseUrl: string = 'http://127.0.0.1:5180') {}

  async staffLogin(account: string, password: string): Promise<AuthSession> {
    const res = await fetch(`${this.baseUrl}/api/auth/staff/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: '登录失败' }));
      throw new Error(err.error || '登录失败');
    }
    return res.json();
  }

  async wechatPhoneLogin(phone: string, wxOpenId?: string, name?: string): Promise<AuthSession> {
    const res = await fetch(`${this.baseUrl}/api/auth/wechat/phone-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, wxOpenId, name }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: '微信手机号登录失败' }));
      throw new Error(err.error || '微信手机号登录失败');
    }
    return res.json();
  }
}
