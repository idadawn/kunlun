import type {
  ActiveStatus,
  AuthSession,
  ContainerLedgerRow,
  ContainerSummaryItem,
  ContainerType,
  CouponTemplate,
  CreateOrderRequest,
  CreateOrderResult,
  CurrentUser,
  DepositLedgerRow,
  DepositSummaryRow,
  ExportDataset,
  FinanceSummaryReport,
  FulfillOrderRequest,
  InventoryOperation,
  InventoryRequest,
  MemberAddress,
  MemberCoupon,
  MemberProfile,
  OverviewReport,
  PayMethod,
  PlanSnapshot,
  RechargeLedgerRow,
  RechargePlan,
  RoleCode,
  SaveCouponTemplateRequest,
  SaveMemberAddressRequest,
  StaffAccount,
  TicketBatch,
  WaterOrder,
  WaterProduct,
  WaterType,
  FulfillMode,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface KunlunApiOptions {
  baseUrl?: string;
  /** Called once when an authenticated request is rejected with 401. */
  onUnauthorized?: () => void;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

/** Typed client for the Kunlun water-station API. All business rules remain server-side. */
export class KunlunApi {
  token: string | null = null;
  private readonly baseUrl: string;
  private readonly options: KunlunApiOptions;

  constructor(options: KunlunApiOptions = {}) {
    this.options = options;
    this.baseUrl = options.baseUrl ?? '';
  }

  private async send(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetch(this.baseUrl + path, { ...init, headers });
    if (res.ok) return res;
    const body = await res.json().catch(() => ({} as Record<string, string>));
    if (res.status === 401 && this.token && !path.startsWith('/api/auth/')) this.options.onUnauthorized?.();
    const message = body.message || body.error || (res.status === 403 ? '当前账号没有此操作权限' : `请求失败 (${res.status})`);
    throw new ApiError(message, res.status);
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.send(path, init);
    return res.status === 204 ? (undefined as T) : res.json();
  }

  private post<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: 'POST', ...(body === undefined ? {} : json(body)) });
  }
  private put<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: 'PUT', ...(body === undefined ? {} : json(body)) });
  }

  // Auth & accounts
  staffLogin(account: string, password: string, requireAdmin = false) {
    return this.post<AuthSession>('/api/auth/staff/login', { account, password, requireAdmin });
  }
  memberLogin(account: string, password: string) {
    return this.post<AuthSession>('/api/auth/member/login', { account, password });
  }
  me() { return this.request<CurrentUser>('/api/auth/me'); }
  logout() { return this.post<unknown>('/api/auth/logout'); }
  changePassword(currentPassword: string, newPassword: string) {
    return this.post<unknown>('/api/auth/change-password', { currentPassword, newPassword });
  }
  setCredentials(subjectType: 'STAFF' | 'MEMBER', id: string, username: string, password: string) {
    return this.put<unknown>(`/api/accounts/${subjectType}/${id}/credentials`, { username, password });
  }
  listStaff() { return this.request<StaffAccount[]>('/api/staff'); }
  createStaff(body: { name: string; phone: string; username: string; password: string; role: Exclude<RoleCode, 'MEMBER'> }) {
    return this.post<StaffAccount>('/api/staff', body);
  }
  setStaffStatus(id: string, status: ActiveStatus) {
    return this.request<{ id: string; status: ActiveStatus }>(`/api/staff/${id}/status`, { method: 'PATCH', ...json({ status }) });
  }

  // Members & address books
  listMembers(q?: string) {
    return this.request<MemberProfile[]>('/api/members' + (q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''));
  }
  memberProfile(memberId: string) { return this.request<MemberProfile>(`/api/members/${memberId}/profile`); }
  createMember(body: { name: string; phone: string; defaultAddress?: string; doorNo?: string; remark?: string }) {
    return this.post<{ id: string; memberNo: string; name: string; phone: string }>('/api/members', body);
  }
  listAddresses(memberId: string) { return this.request<MemberAddress[]>(`/api/members/${memberId}/addresses`); }
  createAddress(memberId: string, body: SaveMemberAddressRequest) {
    return this.post<MemberAddress>(`/api/members/${memberId}/addresses`, body);
  }
  updateAddress(memberId: string, addressId: string, body: SaveMemberAddressRequest) {
    return this.put<MemberAddress>(`/api/members/${memberId}/addresses/${addressId}`, body);
  }
  setDefaultAddress(memberId: string, addressId: string) {
    return this.post<MemberAddress>(`/api/members/${memberId}/addresses/${addressId}/default`);
  }
  deleteAddress(memberId: string, addressId: string) {
    return this.request<void>(`/api/members/${memberId}/addresses/${addressId}`, { method: 'DELETE' });
  }
  depositSummary(memberId: string) { return this.request<DepositSummaryRow[]>(`/api/members/${memberId}/deposit-summary`); }
  ticketBatches(memberId: string) { return this.request<TicketBatch[]>(`/api/members/${memberId}/ticket-batches`); }
  memberCoupons(memberId: string) { return this.request<MemberCoupon[]>(`/api/members/${memberId}/coupons`); }

  // Products, plans & coupons
  listProducts() { return this.request<WaterProduct[]>('/api/products'); }
  updateProduct(waterType: WaterType, body: { name: string; capacityLiters: number; packaging: string; retailPrice: number | null; deliveryMinimum: number }) {
    return this.put<WaterProduct>(`/api/products/${waterType}`, body);
  }
  listPlans() { return this.request<RechargePlan[]>('/api/plans'); }
  savePlan(id: string | null, body: { name: string; waterType: WaterType; fulfillMode: FulfillMode; price: number; buyQty: number; giftQty: 0; status: ActiveStatus }) {
    return id ? this.put<RechargePlan>(`/api/plans/${id}`, body) : this.post<RechargePlan>('/api/plans', body);
  }
  listCouponTemplates() { return this.request<CouponTemplate[]>('/api/coupon-templates'); }
  saveCouponTemplate(id: string | null, body: SaveCouponTemplateRequest) {
    return id ? this.put<{ id: string }>(`/api/coupon-templates/${id}`, body) : this.post<{ id: string }>('/api/coupon-templates', body);
  }
  issueCoupon(templateId: string, memberId: string, idempotencyKey: string) {
    return this.post<{ id: string; idempotentReplay: boolean }>(`/api/coupon-templates/${templateId}/issue`, { memberId, idempotencyKey });
  }

  // Recharges & refunds
  createRecharge(body: { memberId: string; planId: string; couponId: string | null; payMethod: PayMethod; idempotencyKey: string }) {
    return this.post<{ id: string; rechargeNo: string; paidAmount: number; buyQty: number; giftQty: number; totalTickets: number; planSnapshot?: PlanSnapshot; idempotentReplay: boolean }>('/api/recharges', body);
  }
  refundBatch(batchId: string, body: { idempotencyKey: string; payMethod: PayMethod; reason: string }) {
    return this.post<{ id: string; refundNo: string; refundAmount: number; refundBuyQty: number; revokedGiftQty: number; idempotentReplay: boolean }>(`/api/ticket-batches/${batchId}/refund`, body);
  }

  // Orders
  listOrders(params: { memberId?: string; status?: string; pickupCode?: string } = {}) {
    const search = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    return this.request<WaterOrder[]>('/api/orders' + (search.size ? `?${search}` : ''));
  }
  createOrder(body: CreateOrderRequest) { return this.post<CreateOrderResult>('/api/orders', body); }
  acceptOrder(orderId: string) { return this.post<{ id: string; status: string }>(`/api/orders/${orderId}/accept`); }
  cancelOrder(orderId: string, cancelReason: string) {
    return this.post<{ id: string; orderNo: string; status: string }>(`/api/orders/${orderId}/cancel`, { cancelReason });
  }
  fulfillOrder(orderId: string, body: FulfillOrderRequest) {
    return this.post<{ id: string; orderNo: string; status: string }>(`/api/orders/${orderId}/fulfill`, body);
  }
  verifyPickup(body: FulfillOrderRequest & { pickupCode: string }) {
    return this.post<{ id: string; orderNo: string; status: string }>('/api/orders/pickup-verify', body);
  }

  // Containers & deposits
  containerSummary() { return this.request<ContainerSummaryItem[]>('/api/containers/summary'); }
  updateUnitDeposit(containerType: ContainerType, unitDeposit: number) {
    return this.put<{ containerType: ContainerType; unitDeposit: number }>(`/api/containers/${containerType}/unit-deposit?newUnitDeposit=${encodeURIComponent(unitDeposit)}`);
  }
  registerMovement(body: { memberId: string; containerType: ContainerType; fullOutN: number; emptyInM: number; idempotencyKey: string }) {
    return this.post<{ ledgerNo: string; currentHeld: number }>('/api/containers/movements', body);
  }
  collectDeposit(body: { memberId: string; containerType: ContainerType; quantity: number; payMethod: PayMethod; idempotencyKey: string }) {
    return this.post<{ depositNo: string; totalAmount: number }>('/api/deposits/collect', body);
  }
  refundDeposit(body: { memberId: string; containerType: ContainerType; quantity: number; payMethod?: PayMethod; idempotencyKey: string }) {
    return this.post<{ refundNo: string; refundAmount: number }>('/api/deposits/refund', body);
  }
  inventory(body: InventoryRequest) { return this.post<InventoryOperation>('/api/containers/inventory', body); }
  inventoryOperations(containerType?: ContainerType) {
    return this.request<Array<{ operation: InventoryOperation; memberName: string }>>('/api/containers/inventory-operations' + (containerType ? `?containerType=${containerType}` : ''));
  }

  // Reports
  financeSummary() { return this.request<FinanceSummaryReport>('/api/reports/finance-summary'); }
  overview() { return this.request<OverviewReport>('/api/reports/overview'); }
  rechargeLedger() { return this.request<RechargeLedgerRow[]>('/api/ledgers/recharges'); }
  depositLedger() { return this.request<DepositLedgerRow[]>('/api/ledgers/deposits'); }
  containerLedger() { return this.request<ContainerLedgerRow[]>('/api/ledgers/containers'); }
  async exportCsv(dataset: ExportDataset): Promise<Blob> {
    return (await this.send(`/api/exports/${dataset}`)).blob();
  }
}
