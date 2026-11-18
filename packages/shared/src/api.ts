import type {
  ActiveStatus,
  ApplyRefundBody,
  AuthSession,
  CirculationRow,
  ContainerDamageRow,
  ContainerHoldingRow,
  ContainerLedgerRow,
  ContainerSummaryItem,
  ContainerType,
  CreateExpenseRequest,
  CreateOrderRequest,
  ContainerLedgerQuery,
  CreateOrderResult,
  CurrentUser,
  DepositLedgerQuery,
  DepositLedgerRow,
  DepositSummaryRow,
  Expense,
  ExpenseQuery,
  ExpenseSummary,
  ExportDataset,
  FinanceSummaryReport,
  FulfillOrderRequest,
  InventoryOperation,
  InventoryRequest,
  LedgerQuery,
  MemberAddress,
  MemberOpeningRecord,
  MemberProfile,
  MemberStatusResult,
  MemberQuery,
  OpeningEntry,
  SaveOpeningBody,
  MobileConfigOverview,
  OrderQuery,
  OverviewReport,
  Paged,
  PayMethod,
  PlanSnapshot,
  RechargeLedgerQuery,
  RechargeLedgerRow,
  RechargeRefundLedgerRow,
  RefundRequestQuery,
  RefundRequestRow,
  RefundRequestStatus,
  RechargePlan,
  ReviewSettings,
  RoleMobileConfig,
  RoleCode,
  SaveMemberAddressRequest,
  SaveWaterProductRequest,
  SettlementContainerInput,
  SettlementPreview,
  SettlementRequest,
  SettlementSlip,
  StaffAccount,
  TicketBatch,
  TimeRange,
  UpdateStockRequest,
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

/** `?a=1&b=2` from the given values, skipping empty ones. */
const queryString = (params: object) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
    if (text) search.set(key, text);
  }
  return search.size ? `?${search}` : '';
};
/** Paged queries always send `page`; without paging params the server keeps answering with its legacy capped array. */
const paged = (query: object & { page?: number }) => queryString({ ...query, page: query.page ?? 1 });

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
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, { ...init, headers });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new ApiError('网络连接失败，请检查网络后重试', 0);
    }
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
  deleteStaff(id: string) { return this.request<{ id: string; deleted: boolean }>(`/api/staff/${id}`, { method: 'DELETE' }); }
  /** Each role's mobile features; administrators only. */
  mobileRoles() { return this.request<MobileConfigOverview>('/api/mobile/roles'); }
  /** Saves a role's features in workbench order; for clerks and couriers this also sets every such account's permissions. */
  saveMobileRole(role: Exclude<RoleCode, 'MEMBER'>, features: string[]) {
    return this.put<RoleMobileConfig>(`/api/mobile/roles/${role}`, { features });
  }

  // Members & address books
  /** The newest 50 matches, for pickers; tables use `membersPage`. */
  listMembers(q?: string) {
    return this.request<MemberProfile[]>('/api/members' + queryString({ q }));
  }
  membersPage(query: MemberQuery = {}) {
    return this.request<Paged<MemberProfile>>('/api/members' + paged(query));
  }
  memberProfile(memberId: string) { return this.request<MemberProfile>(`/api/members/${memberId}/profile`); }
  memberPhoneAvailability(phone: string) { return this.request<{ available: boolean; message: string | null }>('/api/members/phone-availability' + queryString({ phone })); }
  resetMemberPassword(id: string) { return this.post<{ phone: string; temporaryPassword: string }>(`/api/members/${id}/reset-password`); }
  createMember(body: { name: string; phone: string; defaultAddress?: string; doorNo?: string; remark?: string }) {
    return this.post<{ id: string; memberNo: string; name: string; phone: string; temporaryPassword: string }>('/api/members', body);
  }
  /** 停用（要写原因）或重新启用会员；停用后会员端登录失效，员工也办不了他的业务。 */
  setMemberStatus(memberId: string, status: ActiveStatus, reason?: string) {
    return this.request<MemberStatusResult>(`/api/members/${memberId}/status`, { method: 'PATCH', ...json({ status, reason }) });
  }
  /** 删除一条业务记录都没有的会员（建错、重复的档案）；有记录的服务端拒绝，只能停用。 */
  deleteMember(memberId: string) { return this.request<{ id: string; memberNo: string; deleted: boolean }>(`/api/members/${memberId}`, { method: 'DELETE' }); }
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
  /** What was recorded from before the member used the system: the opening deposits and every opening entry, newest first. */
  memberOpening(memberId: string) { return this.request<MemberOpeningRecord>(`/api/members/${memberId}/opening`); }
  /** Records or corrects packages, deposits and holdings from before the system in one go; needs the opening permission. */
  saveMemberOpening(memberId: string, body: SaveOpeningBody) { return this.post<OpeningEntry>(`/api/members/${memberId}/opening`, body); }

  // Products & plans
  listProducts() { return this.request<WaterProduct[]>('/api/products'); }
  createProduct(body: SaveWaterProductRequest & { containerType: ContainerType }) { return this.post<WaterProduct>('/api/products', body); }
  updateProduct(waterType: WaterType, body: SaveWaterProductRequest) { return this.put<WaterProduct>(`/api/products/${waterType}`, body); }
  /** Only a product without packages, tickets or orders can be deleted. */
  deleteProduct(waterType: WaterType) { return this.request<{ waterType: WaterType; deleted: boolean }>(`/api/products/${waterType}`, { method: 'DELETE' }); }
  listPlans() { return this.request<RechargePlan[]>('/api/plans'); }
  savePlan(id: string | null, body: { name: string; waterType: WaterType; fulfillMode: FulfillMode; price: number; buyQty: number; giftQty: 0; status: ActiveStatus }) {
    return id ? this.put<RechargePlan>(`/api/plans/${id}`, body) : this.post<RechargePlan>('/api/plans', body);
  }

  // Recharges & refunds
  /** `giftQty` is given by hand; while gifts are reviewed a clerk's gift waits (`pendingGiftQty`) and the paid tickets arrive at once. */
  createRecharge(body: { memberId: string; planId: string; payMethod: PayMethod; giftQty?: number; idempotencyKey: string }) {
    return this.post<{
      id: string; rechargeNo: string; paidAmount: number; buyQty: number; giftQty: number; pendingGiftQty: number; giftRequestNo: string | null;
      totalTickets: number; planSnapshot?: PlanSnapshot; idempotentReplay: boolean;
    }>('/api/recharges', body);
  }

  // Refunds and gifts: what needs review waits for an administrator, anything else is done on the spot (status APPROVED)
  applyRefund(body: ApplyRefundBody) {
    return this.post<{ id: string; requestNo: string; status: RefundRequestStatus; estimatedAmount: number; refundNo: string | null; refundAmount: number | null; idempotentReplay: boolean }>('/api/refund-requests', body);
  }
  reviewSettings() { return this.request<ReviewSettings>('/api/settings/review'); }
  saveReviewSettings(body: { giftReview: boolean; refundReview: boolean; depositReview: boolean; damageReview: boolean }) { return this.put<ReviewSettings>('/api/settings/review', body); }
  refundRequests(query: RefundRequestQuery = {}) {
    return this.request<Paged<RefundRequestRow>>('/api/refund-requests' + paged(query));
  }
  /** `amount` is what the reviewer pays back; required when the applicant typed one in. */
  approveRefund(id: string, body: { payMethod?: PayMethod; note?: string; amount?: number }) {
    return this.post<{ id: string; status: RefundRequestStatus; refundNo: string | null; refundAmount: number; idempotentReplay: boolean }>(`/api/refund-requests/${id}/approve`, body);
  }
  rejectRefund(id: string, note: string) {
    return this.post<{ id: string; status: RefundRequestStatus }>(`/api/refund-requests/${id}/reject`, { note });
  }

  // Orders
  /** The newest 50 matches; tables use `ordersPage`. */
  listOrders(params: Pick<OrderQuery, 'memberId' | 'status' | 'pickupCode'> = {}) {
    return this.request<WaterOrder[]>('/api/orders' + queryString(params));
  }
  ordersPage(query: OrderQuery = {}) {
    return this.request<Paged<WaterOrder>>('/api/orders' + paged(query));
  }
  createOrder(body: CreateOrderRequest) { return this.post<CreateOrderResult>('/api/orders', body); }
  acceptOrder(orderId: string) { return this.post<{ id: string; status: string }>(`/api/orders/${orderId}/accept`); }
  cancelOrder(orderId: string, cancelReason: string) {
    return this.post<{ id: string; orderNo: string; status: string }>(`/api/orders/${orderId}/cancel`, { cancelReason });
  }
  fulfillOrder(orderId: string, body: FulfillOrderRequest) {
    return this.post<{ id: string; orderNo: string; status: string; damageRequestNo?: string | null; damageReviewStatus?: 'PENDING' | 'APPROVED' | null }>(`/api/orders/${orderId}/fulfill`, body);
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
  /**
   * `amount`: the money taken, split evenly over the containers; the current standard × quantity when omitted. While deposits are
   * reviewed the deposit waits as a request (status PENDING, no deposit number) until an admin approves it.
   */
  collectDeposit(body: { memberId: string; containerType?: ContainerType; quantity?: number; payMethod: PayMethod; idempotencyKey: string; amount?: number }) {
    return this.post<{ status: 'PENDING' | 'APPROVED'; depositNo?: string | null; requestNo?: string; totalAmount: number }>('/api/deposits/collect', body);
  }

  // 退款结算：一张单子结清会员的水票、押金和桶袋
  settlementPreview(memberId: string, body: { containers?: SettlementContainerInput[]; amount?: number; damageDecisions?: SettlementRequest["damageDecisions"] }) {
    return this.post<SettlementPreview>(`/api/members/${memberId}/settlement/preview`, body);
  }
  settle(memberId: string, body: SettlementRequest) { return this.post<SettlementSlip>(`/api/members/${memberId}/settlement`, body); }
  settlements(memberId: string) { return this.request<SettlementSlip[]>(`/api/members/${memberId}/settlements`); }
  inventory(body: InventoryRequest) { return this.post<InventoryOperation>('/api/containers/inventory', body); }
  updateStock(body: UpdateStockRequest) { return this.post<InventoryOperation>('/api/containers/stock', body); }
  inventoryOperations(containerType?: ContainerType) {
    return this.request<Array<{ operation: InventoryOperation; memberName: string }>>('/api/containers/inventory-operations' + (containerType ? `?containerType=${containerType}` : ''));
  }
  containerHoldings(q: string, page: number) {
    return this.request<Paged<ContainerHoldingRow>>('/api/containers/holdings' + queryString({ q, page }));
  }
  containerCirculation(q: string, containerType: ContainerType | '', page: number) {
    return this.request<Paged<CirculationRow>>('/api/containers/circulation' + queryString({ q, containerType, page }));
  }
  containerDamages(q: string, containerType: ContainerType | '', status: string, page: number) {
    return this.request<Paged<ContainerDamageRow>>('/api/containers/damages' + queryString({ q, containerType, status, page }));
  }
  /** `acceptUncovered` 登记超出已交押金的破损，此时 `uncoveredNote` 必填。 */
  reportDamage(body: { memberId: string; containerType: ContainerType; quantity: number; reason: string; idempotencyKey: string; feePaid?: boolean; acceptUncovered?: boolean; uncoveredNote?: string | null }) {
    return this.post<{ damageNo: string }>('/api/containers/damages', body);
  }
  scrapDamage(id: string, body: { reason: string; idempotencyKey: string; deductDeposit: boolean }) {
    return this.post<{ deductedAmount: number; depositWaived: boolean }>(`/api/containers/damages/${id}/scrap`, body);
  }

  // Reports
  financeSummary() { return this.request<FinanceSummaryReport>('/api/reports/finance-summary'); }
  overview() { return this.request<OverviewReport>('/api/reports/overview'); }
  rechargeLedger(query: RechargeLedgerQuery = {}) { return this.request<Paged<RechargeLedgerRow>>('/api/ledgers/recharges' + paged(query)); }
  rechargeRefundLedger(query: RechargeLedgerQuery = {}) { return this.request<Paged<RechargeRefundLedgerRow>>('/api/ledgers/recharge-refunds' + paged(query)); }
  depositLedger(query: DepositLedgerQuery = {}) { return this.request<Paged<DepositLedgerRow>>('/api/ledgers/deposits' + paged(query)); }
  containerLedger(query: ContainerLedgerQuery = {}) { return this.request<Paged<ContainerLedgerRow>>('/api/ledgers/containers' + paged(query)); }

  // Expenses: purchases such as buckets, bags and parts; a mistake is voided, never deleted
  createExpense(body: CreateExpenseRequest) { return this.post<Expense>('/api/expenses', body); }
  voidExpense(id: string, reason: string) { return this.post<Expense>(`/api/expenses/${id}/void`, { reason }); }
  expenses(query: ExpenseQuery = {}) { return this.request<Paged<Expense>>('/api/expenses' + paged(query)); }
  expenseSummary(range: TimeRange = {}) { return this.request<ExpenseSummary>('/api/expenses/summary' + queryString(range)); }

  async exportCsv(dataset: ExportDataset): Promise<Blob> {
    return (await this.send(`/api/exports/${dataset}`)).blob();
  }
}
