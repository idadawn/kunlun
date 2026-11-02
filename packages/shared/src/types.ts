/** A water product code from /api/products: BUCKET_18_9L and BAG_7_5L for the two original products, generated codes for added ones. */
export type WaterType = string;
export type FulfillMode = 'DELIVERY' | 'PICKUP';
export type ContainerType = 'BUCKET' | 'BAG';
export type RoleCode = 'ADMIN' | 'CLERK' | 'COURIER' | 'MEMBER';
export type SubjectType = 'STAFF' | 'MEMBER';
export type PayMethod = 'CASH' | 'WECHAT' | 'ALIPAY' | 'BANK';
export type ActiveStatus = 'ACTIVE' | 'DISABLED';
export type OrderStatus = 'PENDING' | 'DISPATCHED' | 'COMPLETED' | 'CANCELLED';

export interface AuthSession {
  accessToken: string;
  subjectType: SubjectType;
  subjectId: string;
  displayName: string;
  codeOrNo: string;
  phone: string;
  role: RoleCode;
  permissions: string[];
  tokenVersion?: number;
  isNewMember?: boolean;
}

export interface CurrentUser {
  sub: string;
  subjectId: string;
  subjectType: SubjectType;
  displayName: string;
  codeOrNo: string;
  phone: string;
  role: RoleCode;
  permissions: string[];
}

export interface MemberProfile {
  id: string;
  memberNo: string;
  name: string;
  phone: string;
  /** Display text of the default delivery address; empty when the member has none. */
  defaultAddress: string;
  /** Non-empty balances, oldest product first; a product and mode missing here has no tickets. */
  tickets: MemberTicket[];
  depositAmount: number;
  heldBuckets: number;
  heldBags: number;
  status: ActiveStatus;
  createdAt?: string;
  /** Staff note recorded when the member was created; null when none. */
  remark?: string | null;
}

/** Tickets of one water product for one fulfilment mode; tickets of one product never pay for another. */
export interface MemberTicket {
  waterType: WaterType;
  name: string;
  containerType: ContainerType;
  unit: '桶' | '袋';
  fulfillMode: FulfillMode;
  available: number;
  /** Held by orders that are not fulfilled yet. */
  reserved: number;
}

/** 会员收货地址：收货地址 + 门牌号 + 联系人 + 手机号，每位会员最多一个默认地址。 */
export interface MemberAddress {
  id: string;
  memberId: string;
  contactName: string;
  contactPhone: string;
  /** 收货地址：小区、街道或楼栋 */
  location: string;
  /** 门牌号：单元、楼层及房号 */
  doorNo: string;
  fullAddress: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SaveMemberAddressRequest {
  contactName: string;
  contactPhone: string;
  location: string;
  doorNo: string;
  isDefault: boolean;
}

export interface WaterProduct {
  waterType: WaterType;
  name: string;
  capacityLiters: number;
  packaging: string;
  retailPrice: number | null;
  deliveryMinimum: number;
  deliveryFee: number;
  /** The reusable container (and deposit) this water travels in; chosen when the product is added and fixed after. */
  containerType: ContainerType;
}

export interface SaveWaterProductRequest {
  name: string;
  capacityLiters: number;
  packaging: string;
  retailPrice: number | null;
  deliveryMinimum: number;
  /** Required when adding a product; an edit keeps the container. */
  containerType?: ContainerType;
}

export interface RechargePlan {
  id: string;
  name: string;
  waterType: WaterType;
  fulfillMode: FulfillMode;
  price: number;
  buyQty: number;
  giftQty: number;
  status: ActiveStatus;
}

export interface OrderAddressSnapshot {
  addressId?: string | null;
  contactName: string;
  contactPhone: string;
  location?: string;
  doorNo?: string;
  /** Full display text, kept for orders created before address books existed. */
  address: string;
  snapshotAt?: string;
}

export interface OrderProductSnapshot {
  waterLabel: string;
  capacityLiters: number;
  deliveryMinimum: number;
  deliveryFee: number;
  /** Absent on orders placed before water products could be added. */
  containerType?: ContainerType;
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
  addressSnapshot: OrderAddressSnapshot;
  productSnapshot?: OrderProductSnapshot | null;
  status: OrderStatus;
  diffReason?: string | null;
  cancelReason?: string | null;
  createdAt: string;
  /** Delivery note from whoever placed the order, e.g. where to leave empty buckets. */
  remark?: string | null;
}

export interface CreateOrderRequest {
  memberId: string;
  waterType: WaterType;
  fulfillMode: FulfillMode;
  orderQty: number;
  idempotencyKey: string;
  /** Required for delivery unless the member has a default address. */
  addressId?: string | null;
  appointmentSlot?: string | null;
  remark?: string | null;
}

export interface CreateOrderResult {
  id: string;
  orderNo: string;
  waterType: WaterType;
  fulfillMode: FulfillMode;
  orderQty: number;
  reservedQty: number;
  availableTicketsAfter: number;
  reservedTicketsAfter: number;
  pickupCode?: string | null;
  status: OrderStatus;
  addressSnapshot: OrderAddressSnapshot;
  remark?: string | null;
  idempotentReplay: boolean;
}

export interface FulfillOrderRequest {
  actualQty: number;
  fullOutN: number;
  emptyInM: number;
  pickupCode?: string | null;
  diffReason?: string | null;
}

/**
 * 现存总量 = 门店可用 + 会员持有 + 待报废 + 客户手里未登记；累计报废另计。
 * 盘点时答"说不清"的项目是待核实：数字只是上次记下的参考，现存总量也就说不准。
 */
export interface ContainerSummaryItem {
  containerType: ContainerType;
  unitDeposit: number;
  totalQty: number;
  inStationQty: number;
  /** 登记在具体会员名下的数量。 */
  memberHeldQty: number;
  /** 会员破损归还、尚未确认报废扣押金的数量。 */
  damagedQty: number;
  scrappedQty: number;
  warnThreshold: number;
  /** 盘点时客户手里比会员名下登记多出来、还没登记到人的数量。 */
  unregisteredOutQty: number;
  /** 店里的数量待核实。 */
  inStationUnknown: boolean;
  /** 客户手里的数量待核实。 */
  outUnknown: boolean;
  /** 最近一次盘点时间。 */
  countedAt: string | null;
  identityValid: boolean;
  lowStockWarning: boolean;
}

export interface FinanceSummaryReport {
  brand: string;
  rechargeRevenueTotal: number;
  rechargeRefundedTotal: number;
  rechargeRefundCount: number;
  rechargeNetReceived: number;
  rechargeOrderCount: number;
  ticketsSoldBuyQty: number;
  ticketsGiftedQty: number;
  depositCollectedTotal: number;
  depositCollectCount: number;
  depositRefundedTotal: number;
  depositDeductedTotal: number;
  depositDeductCount: number;
  depositRefundCount: number;
  unrefundedDepositPoolTotal: number;
  netDepositFromFlows: number;
  reconciledZeroDiff: boolean;
  completedOrderCount: number;
  waterFulfilledTotalQty: number;
  generatedAt: string;
}

export interface OverviewReport {
  pendingDelivery: number;
  pendingPickup: number;
  dispatched: number;
  completedOrders: number;
  completedBuckets: number;
  completedBags: number;
  memberCount: number;
  newMembersMonth: number;
  membersWithTickets: number;
  membersWithContainers: number;
  refundableDeposit: number;
  trend: Array<{ date: string; rechargeAmount: number; waterQty: number }>;
}

export interface PlanSnapshot {
  name?: string;
  waterType: WaterType;
  fulfillMode: FulfillMode;
  waterLabel?: string;
  [key: string]: unknown;
}

export interface RechargeLedgerRow {
  rechargeNo: string;
  memberName: string;
  memberNo: string;
  planName: string;
  planSnapshot: PlanSnapshot;
  paidAmount: number;
  buyQty: number;
  giftQty: number;
  payMethod: PayMethod;
  operatorName: string;
  createdAt: string;
  /** Set once the batch's remaining tickets were refunded. */
  refundNo: string | null;
  refundAmount: number | null;
  refundedAt: string | null;
  /** A gift a clerk gave by hand that went to review; null when any gift arrived at once. */
  giftReview: GiftReview | null;
}

export interface GiftReview {
  status: RefundRequestStatus;
  quantity: number;
  reviewerName: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
}

/** 水费退款：退清某次充值剩余权益，与押金退款分开记账。 */
export interface RechargeRefundLedgerRow {
  refundNo: string;
  rechargeNo: string;
  memberName: string;
  memberNo: string;
  planName: string;
  waterType: WaterType;
  fulfillMode: FulfillMode;
  amount: number;
  refundBuyQty: number;
  revokedGiftQty: number;
  payMethod: PayMethod;
  reason: string;
  /** Who refunded it. */
  operatorName: string;
  createdAt: string;
  /** Who filed the refund; null for refunds made before requests were recorded. */
  applicantName: string | null;
}

export type DepositFlowType = 'COLLECT' | 'REFUND' | 'DEDUCT';

export interface DepositLedgerRow {
  docNo: string;
  memberName: string;
  memberNo: string;
  flowType: DepositFlowType;
  containerType: ContainerType;
  qty: number;
  unitPrice: number;
  amount: number;
  remainingQty: number;
  /** How the money changed hands; null for scrap deductions and refunds registered before it was recorded. */
  payMethod: PayMethod | null;
  operatorName: string;
  createdAt: string;
  /** Who filed a refund (the operator paid it out); null for collections and deductions. */
  applicantName: string | null;
  /** Why a refund or deduction was made, when one was given. */
  reason: string | null;
}

export interface ContainerLedgerRow {
  ledgerNo: string;
  memberName: string;
  orderNo: string;
  containerType: ContainerType;
  fullOutQty: number;
  emptyInQty: number;
  deltaHeld: number;
  heldAfter: number;
  operatorName: string;
  createdAt: string;
}

export interface PageQuery {
  page?: number;
  pageSize?: number;
}

/** Business-time window: `from` inclusive, `to` exclusive, ISO 8601. */
export interface TimeRange {
  from?: string;
  to?: string;
}

export interface MemberQuery extends PageQuery {
  /** Matches member number, name or phone. */
  q?: string;
  status?: ActiveStatus;
  /** Members holding usable tickets of any water carried in this kind of container. */
  water?: ContainerType;
}

export interface OrderQuery extends PageQuery, TimeRange {
  memberId?: string;
  status?: OrderStatus;
  pickupCode?: string;
  mode?: FulfillMode;
  /** Matches order number, pickup code, contact snapshot, address, or the member's name / phone. */
  q?: string;
}

export interface LedgerQuery extends PageQuery, TimeRange {
  /** Matches document number, member (name, number or phone), plan or operator. */
  q?: string;
}

export interface RechargeLedgerQuery extends LedgerQuery {
  payMethod?: PayMethod;
}

export interface DepositLedgerQuery extends LedgerQuery {
  flowType?: DepositFlowType;
  containerType?: ContainerType;
}

export interface ContainerLedgerQuery extends PageQuery {
  containerType?: ContainerType;
}

export interface TicketBatch {
  id: string;
  source: 'PURCHASE' | 'LEGACY' | string;
  waterType: WaterType;
  fulfillMode: FulfillMode;
  paidAmount: number;
  fixedQty: number;
  giftQty: number;
  remainingBuy: number;
  remainingGift: number;
  reservedBuy: number;
  reservedGift: number;
  status: 'ACTIVE' | 'REFUNDED' | string;
  createdAt: string;
  rechargeNo: string;
  name: string;
  refundableAmount: number;
  refundedAmount: number;
  refundNo: string;
  waterLabel: string;
  /** A refund request for this batch that waits for review. */
  pendingRequestNo: string | null;
  /** Tickets a clerk gave away by hand that wait for an administrator's approval. */
  pendingGiftQty: number;
}

export interface DepositSummaryRow {
  /** Current standard for estimating the next hand-over; historical lots keep their original prices. */
  unitDeposit: number;
  containerType: ContainerType;
  paidQty: number;
  paidAmount: number;
  heldQty: number;
  pendingDamageQty: number;
  pendingDamageAmount: number;
  refundableQty: number;
  refundableAmount: number;
  /** Already asked back in refund requests awaiting review; new requests can cover only the rest. */
  pendingRefundQty: number;
}

export interface StaffAccount {
  id: string;
  staffNo: string;
  name: string;
  phone: string;
  username: string;
  role: Exclude<RoleCode, 'MEMBER'>;
  status: ActiveStatus;
}

export type InventoryAction = 'RECEIVE' | 'SCRAP';
/** EXTERNAL：入库；AVAILABLE：门店报废；DAMAGED：会员破损确认报废。早期记录可能带有已停用的来源。 */
export type InventorySource = 'EXTERNAL' | 'AVAILABLE' | 'DAMAGED' | 'COUNT';

/** 入库计入门店可用，报废从门店可用扣减。 */
export interface InventoryRequest {
  containerType: ContainerType;
  action: InventoryAction;
  reason: string;
  idempotencyKey: string;
  quantity: number;
}

export interface InventoryBalance {
  totalQty: number;
  inStationQty: number;
  memberHeldQty: number;
  damagedQty: number;
  scrappedQty: number;
  /** Absent on operations recorded before stock-takes existed. */
  unregisteredOutQty?: number;
  inStationUnknown?: boolean;
  outUnknown?: boolean;
}

/** 盘点：null 表示"说不清"，记为待核实；scrapQty 是店里坏了要报废的，不含在店里能用的里面。 */
export interface StocktakeRequest {
  containerType: ContainerType;
  inStationQty: number | null;
  withCustomersQty: number | null;
  scrapQty: number;
  idempotencyKey: string;
  note?: string;
}

/** What was answered in a stock-take, next to what members were registered as holding at that moment. */
export interface StocktakeAnswers {
  inStationQty: number | null;
  withCustomersQty: number | null;
  registeredHeldQty: number;
  scrapQty: number;
}

export interface InventoryOperation {
  id: string;
  operationNo: string;
  containerType: ContainerType;
  /** COUNT is a stock-take; RECEIVE and SCRAP are single stock changes. */
  action: InventoryAction | 'COUNT';
  sourceState: InventorySource;
  quantity: number;
  deltaTotal: number;
  memberId: string | null;
  reason: string;
  operatorName: string;
  before: InventoryBalance;
  after: InventoryBalance;
  /** Set on stock-takes (action COUNT). */
  counted?: StocktakeAnswers | null;
  createdAt: string;
}

/** One server-side page; `page` and `pageSize` echo the values the server applied (pageSize is capped at 100). */
export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ContainerHoldingRow {
  id: string;
  memberNo: string;
  name: string;
  phone: string;
  heldBags: number;
  heldBuckets: number;
  depositAmount: number;
  pendingDamageQty: number;
  pendingDamageAmount: number;
}

export type CirculationBusinessType = 'TURNOVER' | 'DAMAGE_RETURN' | 'SCRAP' | 'SCRAP_WAIVED';

export interface CirculationRow {
  ledgerNo: string;
  memberName: string;
  memberNo: string;
  containerType: ContainerType;
  fullOutQty: number;
  emptyInQty: number;
  deltaHeld: number;
  heldAfter: number;
  operatorName: string;
  createdAt: string;
  referenceNo: string;
  businessType: CirculationBusinessType;
  depositDeductedAmount: number;
  remark: string;
  scrappedQty: number;
}

export type DamageStatus = 'PENDING' | 'SCRAPPED';

export interface ContainerDamageRow {
  id: string;
  damageNo: string;
  memberName: string;
  memberNo: string;
  containerType: ContainerType;
  quantity: number;
  depositAmount: number;
  status: DamageStatus;
  reason: string;
  operatorName: string;
  createdAt: string;
  lotBreakdown: Array<{ lotId: string; lotNo: string; quantity: number; unitPrice: number }>;
  scrapNo: string;
  scrapReason: string;
  /** Scrapped without deducting the deposit; the reserved deposit went back to the member. */
  depositWaived: boolean;
}

/** GIFT: tickets a clerk gave away by hand while gifts are reviewed. */
export type RefundKind = 'DEPOSIT' | 'RECHARGE' | 'GIFT';
export type RefundRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/** 审核开关：店员的手动赠送、退押金和退水费要不要管理员审核；管理员自己办理总是直接生效。 */
export interface ReviewSettings {
  giftReview: boolean;
  refundReview: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** 审核申请：押金退款、退清充值剩余权益或店员手动赠送的水票，不需要审核时当场记为已通过。 */
export interface RefundRequestRow {
  id: string;
  requestNo: string;
  kind: RefundKind;
  status: RefundRequestStatus;
  memberId: string;
  memberName: string;
  memberNo: string;
  memberPhone: string;
  containerType: ContainerType | null;
  quantity: number | null;
  batchId: string | null;
  rechargeNo: string | null;
  planName: string | null;
  waterType: WaterType | null;
  fulfillMode: FulfillMode | null;
  remainingBuy: number | null;
  remainingGift: number | null;
  /** At application; the refunded amount is fixed at approval. */
  estimatedAmount: number;
  payMethod: PayMethod | null;
  reason: string;
  applicantName: string;
  createdAt: string;
  reviewerName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  refundNo: string | null;
  refundAmount: number | null;
  /** The recharge a refund or gift belongs to: what was paid and how many tickets were bought. */
  rechargePaid: number | null;
  rechargeBuyQty: number | null;
}

export interface RefundRequestQuery extends PageQuery {
  status?: RefundRequestStatus;
  kind?: RefundKind;
  q?: string;
}

export type ApplyRefundBody =
  | { kind: 'DEPOSIT'; memberId: string; containerType: ContainerType; quantity: number; payMethod: PayMethod; reason?: string; idempotencyKey: string }
  | { kind: 'RECHARGE'; memberId: string; batchId: string; payMethod: PayMethod; reason?: string; idempotencyKey: string };

export type ExportDataset =
  | 'members'
  | 'orders'
  | 'recharges'
  | 'recharge-refunds'
  | 'ticket-ledgers'
  | 'deposit-ledgers'
  | 'container-ledgers'
  | 'inventory-operations';
