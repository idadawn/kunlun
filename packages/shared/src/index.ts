export const KUNLUN_BRAND = {
  brand: '绿麒麟',
  store: '绿麒麟水站',
  product: '小分子团弱碱活性水',
  system: '绿麒麟·水站会员管理系统',
  signage: '绿麒麟水站｜小分子团弱碱活性水',
  slogan: '鲜活每一滴，好水到你家',
} as const;

// Stable legacy account keys; physical capacity is supplied by /api/products.
export type WaterType = 'BUCKET_18_9L' | 'BAG_7_5L';
export type FulfillMode = 'DELIVERY' | 'PICKUP';
export type ContainerType = 'BUCKET' | 'BAG';
export type RoleCode = 'ADMIN' | 'CLERK' | 'COURIER' | 'MEMBER';
export type SubjectType = 'STAFF' | 'MEMBER';

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

export interface MemberProfile {
  id: string;
  memberNo: string;
  name: string;
  phone: string;
  defaultAddress: string;
  bucketDeliveryTickets: number;
  bucketPickupTickets: number;
  bagPickupTickets: number;
  bagDeliveryTickets: number;
  depositAmount: number;
  heldBuckets: number;
  heldBags: number;
  status: string;
  reservedBucketDeliveryTickets: number;
  reservedBucketPickupTickets: number;
  reservedBagPickupTickets: number;
  reservedBagDeliveryTickets: number;
  createdAt?: string;
}

export interface WaterProduct {
  waterType: WaterType; name: string; capacityLiters: number; packaging: string; retailPrice: number | null; deliveryMinimum: number; deliveryFee: number;
}

export interface RechargePlan {
  id: string;
  name: string;
  waterType: WaterType;
  fulfillMode: FulfillMode;
  price: number;
  buyQty: number;
  giftQty: number;
  status: string;
}

export interface WaterOrder {
  id: string;
  orderNo: string;
  memberId: string;
  waterType: WaterType;
  fulfillMode: FulfillMode;
  orderQty: number;
  reservedQty: number;
  actualQty?: number | null;
  fullOutQty?: number | null;
  emptyInQty?: number | null;
  pickupCode?: string | null;
  addressSnapshot: {
    contactName: string;
    contactPhone: string;
    address: string;
    snapshotAt?: string;
  };
  status: 'PENDING' | 'DISPATCHED' | 'COMPLETED' | 'CANCELLED';
  diffReason?: string | null;
  cancelReason?: string | null;
  createdAt: string;
}

export interface ContainerSummaryItem {
  containerType: ContainerType;
  unitDeposit: number;
  totalQty: number;
  inStationQty: number;
  inTransitQty: number;
  memberHeldQty: number;
  inspectingQty: number;
  abnormalQty: number;
  damagedQty: number;
  scrappedQty: number;
  warnThreshold: number;
  identityValid: boolean;
  lowStockWarning: boolean;
}

export interface FinanceSummaryReport {
  brand: string;
  rechargeRevenueTotal: number;
  rechargeRefundedTotal: number;
  rechargeNetReceived: number;
  rechargeOrderCount: number;
  ticketsSoldBuyQty: number;
  ticketsGiftedQty: number;
  depositCollectedTotal: number;
  depositCollectCount: number;
  depositRefundedTotal: number;
  depositRefundCount: number;
  unrefundedDepositPoolTotal: number;
  netDepositFromFlows: number;
  reconciledZeroDiff: boolean;
  completedOrderCount: number;
  waterFulfilledTotalQty: number;
  generatedAt: string;
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

export class KunlunApiClient {
  private token: string | null = null;

  constructor(private readonly baseUrl: string = 'http://127.0.0.1:5180') {}

  setToken(token: string | null) {
    this.token = token;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string>),
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP_${res.status}`, message: res.statusText }));
      throw new Error(body.message || body.error || `请求失败 (${res.status})`);
    }
    return res.json();
  }

  // M1: Auth & RBAC
  async staffLogin(account: string, password: string, requireAdmin = false): Promise<AuthSession> {
    const session = await this.request<AuthSession>('/api/auth/staff/login', {
      method: 'POST',
      body: JSON.stringify({ account, password, requireAdmin }),
    });
    this.token = session.accessToken;
    return session;
  }

  async memberLogin(account: string, password: string): Promise<AuthSession> {
    const session = await this.request<AuthSession>('/api/auth/member/login', { method: 'POST', body: JSON.stringify({ account, password }) });
    this.token = session.accessToken;
    return session;
  }

  // M2: Members, Recharge Plans, Recharges, Deposits & Container Movements
  async listMembers(q?: string): Promise<MemberProfile[]> {
    const qs = q ? `?q=${encodeURIComponent(q)}` : '';
    return this.request<MemberProfile[]>(`/api/members${qs}`);
  }

  async getMemberProfile(memberId: string): Promise<MemberProfile> {
    return this.request<MemberProfile>(`/api/members/${memberId}/profile`);
  }

  async createMember(name: string, phone: string, defaultAddress?: string, remark?: string) {
    return this.request<{ id: string; memberNo: string; name: string; phone: string }>('/api/members', {
      method: 'POST',
      body: JSON.stringify({ name, phone, defaultAddress, remark }),
    });
  }

  async listPlans(): Promise<RechargePlan[]> {
    return this.request<RechargePlan[]>('/api/plans');
  }

  async updatePlan(plan: RechargePlan) {
    return this.request<RechargePlan>(`/api/plans/${plan.id}`, { method: 'PUT', body: JSON.stringify(plan) });
  }

  async createRecharge(memberId: string, planId: string, payMethod: string, idempotencyKey: string, remark?: string, couponId?: string) {
    return this.request<{
      id: string;
      rechargeNo: string;
      paidAmount: number;
      buyQty: number;
      giftQty: number;
      totalTickets: number;
      idempotentReplay: boolean;
    }>('/api/recharges', {
      method: 'POST',
      body: JSON.stringify({ memberId, planId, payMethod, idempotencyKey, remark, couponId }),
    });
  }

  async collectDeposit(memberId: string, containerType: ContainerType, quantity: number, payMethod: string, idempotencyKey: string) {
    return this.request<{
      depositNo: string;
      unitPrice: number;
      quantity: number;
      totalAmount: number;
      idempotentReplay: boolean;
    }>('/api/deposits/collect', {
      method: 'POST',
      body: JSON.stringify({ memberId, containerType, quantity, payMethod, idempotencyKey }),
    });
  }

  async refundDeposit(memberId: string, containerType: ContainerType, refundQty: number, idempotencyKey: string, reason?: string) {
    return this.request<{
      refundNo: string;
      refundQty: number;
      refundAmount: number;
      lotBreakdown: Array<{ depositNo: string; unitPrice: number; deductQty: number; subAmount: number }>;
    }>('/api/deposits/refund', {
      method: 'POST',
      body: JSON.stringify({ memberId, containerType, quantity: refundQty, idempotencyKey, reason }),
    });
  }

  async registerContainerMovement(memberId: string, containerType: ContainerType, fullOutN: number, emptyInM: number, orderNo?: string) {
    return this.request<{
      memberId: string;
      containerType: ContainerType;
      fullOutN: number;
      emptyInM: number;
      delta: number;
      newHeld: number;
      depositAmountUnchanged: number;
    }>('/api/containers/movements', {
      method: 'POST',
      body: JSON.stringify({ memberId, containerType, fullOutN, emptyInM, orderNo }),
    });
  }

  // M3: Orders, Pickup Code Verification & Container Inventory
  async listOrders(params?: { memberId?: string; status?: string; pickupCode?: string }): Promise<WaterOrder[]> {
    const search = new URLSearchParams();
    if (params?.memberId) search.set('memberId', params.memberId);
    if (params?.status) search.set('status', params.status);
    if (params?.pickupCode) search.set('pickupCode', params.pickupCode);
    const qs = search.toString() ? `?${search.toString()}` : '';
    return this.request<WaterOrder[]>(`/api/orders${qs}`);
  }

  async createOrder(payload: {
    memberId: string;
    waterType: WaterType;
    fulfillMode: FulfillMode;
    orderQty: number;
    idempotencyKey: string;
    addressOverride?: string;
    appointmentSlot?: string;
  }) {
    return this.request<{
      id: string;
      orderNo: string;
      pickupCode?: string | null;
      availableTicketsAfter: number;
      reservedTicketsAfter: number;
      status: string;
    }>('/api/orders', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async cancelOrder(orderId: string, cancelReason: string) {
    return this.request<{
      id: string;
      orderNo: string;
      status: string;
      releasedTickets: number;
      availableTicketsAfter: number;
      reservedTicketsAfter: number;
    }>(`/api/orders/${orderId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ cancelReason }),
    });
  }

  async fulfillOrder(
    orderId: string,
    payload: {
      actualQty: number;
      fullOutN: number;
      emptyInM: number;
      pickupCode?: string;
      diffReason?: string;
      forceCreditOverride?: boolean;
      overrideReason?: string;
    }
  ) {
    return this.request<{
      id: string;
      orderNo: string;
      status: string;
      actualQty: number;
      fullOutN: number;
      emptyInM: number;
      deltaHeld: number;
      heldAfter: number;
      coveredDepositQty: number;
      availableTicketsAfter: number;
      reservedTicketsAfter: number;
    }>(`/api/orders/${orderId}/fulfill`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async verifyPickupCode(payload: {
    pickupCode: string;
    actualQty: number;
    fullOutN: number;
    emptyInM: number;
    diffReason?: string;
  }) {
    return this.request<{
      id: string;
      orderNo: string;
      status: string;
      actualQty: number;
      heldAfter: number;
      availableTicketsAfter: number;
      reservedTicketsAfter: number;
    }>('/api/orders/pickup-verify', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async getContainerSummary(): Promise<ContainerSummaryItem[]> {
    return this.request<ContainerSummaryItem[]>('/api/containers/summary');
  }

  // M4: Finance Reconciliation Summary & CSV Exports
  async getFinanceSummary(): Promise<FinanceSummaryReport> {
    return this.request<FinanceSummaryReport>('/api/reports/finance-summary');
  }

  async downloadExportCsv(dataset: 'members' | 'ticket-ledgers' | 'deposit-ledgers' | 'orders'): Promise<string> {
    const headers: Record<string, string> = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(`${this.baseUrl}/api/exports/${dataset}`, { headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: `导出失败 (${res.status})` }));
      throw new Error(err.message || err.error || `导出失败 (${res.status})`);
    }
    return res.text();
  }
}

export { KunlunApiClient as KunlunAuthClient };
