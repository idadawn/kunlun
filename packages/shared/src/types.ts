/** A water product code from /api/products: BUCKET_18_9L and BAG_7_5L for the two original products, generated codes for added ones. */
export type WaterType = string;
export type FulfillMode = 'DELIVERY' | 'PICKUP';
export type ContainerKind = 'BUCKET' | 'BAG';
/** Stable per-product container account ID; BUCKET/BAG are the two original accounts. */
export type ContainerType = string;
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
  /** Staff only: the mobile features their role has, in workbench order (see `mobileLayout`). */
  mobileFeatures?: string[] | null;
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
  /** Physical packaging kind; accounting uses the unique containerId. */
  containerType: ContainerKind;
  containerId: ContainerType;
  unitDeposit: number;
}

export interface SaveWaterProductRequest {
  name: string;
  capacityLiters: number;
  packaging: string;
  retailPrice: number | null;
  deliveryMinimum: number;
  /** Required when adding a product; an edit keeps the container. */
  containerType?: ContainerKind;
  unitDeposit?: number;
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
  containerId?: ContainerType;
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
 * 一种桶袋的三个数：店里、客户手里、累计报废，随时可以改；领桶、还桶、破损登记会自动增减。
 * 现存总量 = 店里 + 客户手里 + 待确认报废（会员退回的破损），累计报废不算在内。
 */
export interface ContainerSummaryItem {
  containerType: ContainerType;
  unitDeposit: number;
  totalQty: number;
  /** 店里能用的。 */
  inStationQty: number;
  /** 客户手里的，可以多于或少于登记在会员名下的。 */
  withCustomersQty: number;
  /** 登记在具体会员名下的数量，客户手里的参考。 */
  memberHeldQty: number;
  /** 会员破损归还、尚未确认报废扣押金的数量。 */
  damagedQty: number;
  scrappedQty: number;
  /** 店里少于这个数时提醒，0 表示不提醒。 */
  warnThreshold: number;
  /** 最近一次手动修改数量的时间。 */
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
  /** Containers the unrefunded deposit pays for, those awaiting a scrap decision included. */
  unrefundedDepositQty: number;
  netDepositFromFlows: number;
  reconciledZeroDiff: boolean;
  /** Unused paid tickets of active recharge batches at their original paid price: what refunding them all would pay back. */
  unusedRechargeValue: number;
  unusedPaidTicketQty: number;
  /** Gift tickets still on active recharge batches; a refund takes them back without paying for them. */
  unusedGiftTicketQty: number;
  /** Opening-balance tickets with no recorded price, left out of `unusedRechargeValue`. */
  legacyTicketQty: number;
  /** Money members could still ask back: the unrefunded deposit plus `unusedRechargeValue`. Not income. */
  potentialRefundTotal: number;
  /** Net recharge receipts minus `unusedRechargeValue`: the water fees members have already used up. */
  rechargeEarnedTotal: number;
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
  /** Remaining paid tickets at the original paid price (gifts are worth nothing); 0 for opening balances and refunded batches. */
  remainingValue: number;
  /** `remainingValue` while no open order holds tickets of the batch, else 0. */
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
  waterType: WaterType;
  name: string;
  containerKind: ContainerKind;
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

/** 一个角色的手机端功能：店员、送水员的权限即这些功能所需权限的并集；管理员权限不变。 */
export interface RoleMobileConfig {
  role: Exclude<RoleCode, 'MEMBER'>;
  /** Enabled feature keys in workbench order. */
  features: string[];
  /** What the role's accounts hold now. */
  permissions: string[];
  /** The role's starting features, for 恢复默认. */
  defaults: string[];
  /** Accounts with this role, enabled or not. */
  staffCount: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface MobileConfigOverview {
  /** Every feature the server knows with the permissions it grants. */
  catalog: Array<{ key: string; permissions: string[] }>;
  roles: RoleMobileConfig[];
}

export type InventoryAction = 'RECEIVE' | 'SCRAP';
/** EXTERNAL：新购；AVAILABLE：门店报废；DAMAGED：会员破损确认报废；MANUAL：修改数量；COUNT：早期的盘点。 */
export type InventorySource = 'EXTERNAL' | 'AVAILABLE' | 'DAMAGED' | 'MANUAL' | 'COUNT';

/** 新购计入店里，报废从店里扣减并计入累计报废。 */
export interface InventoryRequest {
  containerType: ContainerType;
  action: InventoryAction;
  reason: string;
  idempotencyKey: string;
  quantity: number;
}

/** 修改数量：直接填现在的数，没填的不动。 */
export interface UpdateStockRequest {
  containerType: ContainerType;
  idempotencyKey: string;
  inStationQty?: number;
  withCustomersQty?: number;
  scrappedQty?: number;
  /** 店里少于多少个时提醒，0 表示不提醒。 */
  warnThreshold?: number;
  note?: string;
}

export interface InventoryBalance {
  totalQty: number;
  inStationQty: number;
  /** Absent on records written before 客户手里 was its own count: it was memberHeldQty + unregisteredOutQty then. */
  withCustomersQty?: number;
  memberHeldQty: number;
  damagedQty: number;
  scrappedQty: number;
  /** Only on records from the retired stock-take. */
  unregisteredOutQty?: number;
}

export interface InventoryOperation {
  id: string;
  operationNo: string;
  containerType: ContainerType;
  /** ADJUST is 修改数量; COUNT is a stock-take from before; RECEIVE and SCRAP are single stock changes. */
  action: InventoryAction | 'ADJUST' | 'COUNT';
  sourceState: InventorySource;
  quantity: number;
  deltaTotal: number;
  memberId: string | null;
  reason: string;
  operatorName: string;
  before: InventoryBalance;
  after: InventoryBalance;
  /** Set when 修改数量 changed the reminder threshold. */
  warnThreshold?: { before: number; after: number } | null;
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
  holdings: Array<{ containerType: ContainerType; name: string; containerKind: ContainerKind; quantity: number }>;
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
