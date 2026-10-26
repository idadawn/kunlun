// Stable legacy account keys; physical capacity is supplied by /api/products.
export type WaterType = 'BUCKET_18_9L' | 'BAG_7_5L';
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
  bucketDeliveryTickets: number;
  bucketPickupTickets: number;
  bagPickupTickets: number;
  bagDeliveryTickets: number;
  depositAmount: number;
  heldBuckets: number;
  heldBags: number;
  status: ActiveStatus;
  reservedBucketDeliveryTickets: number;
  reservedBucketPickupTickets: number;
  reservedBagPickupTickets: number;
  reservedBagDeliveryTickets: number;
  createdAt?: string;
  /** Staff note recorded when the member was created; null when none. */
  remark?: string | null;
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
  pendingMemberDamageQty: number;
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
  depositDeductedTotal: number;
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
}

export interface DepositLedgerRow {
  docNo: string;
  memberName: string;
  flowType: 'COLLECT' | 'REFUND' | 'DEDUCT';
  containerType: ContainerType;
  qty: number;
  unitPrice: number;
  amount: number;
  remainingQty: number;
  operatorName: string;
  createdAt: string;
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
  /** Members who still hold tickets of this kind. */
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
  /** Matches document number, member, plan or operator. */
  q?: string;
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
}

export interface CouponTemplate {
  id: string;
  name: string;
  planId: string;
  giftQty: number;
  startsAt: string;
  expiresAt: string;
  perMemberLimit: number;
  status: ActiveStatus;
}

export interface SaveCouponTemplateRequest {
  name: string;
  planId: string;
  giftQty: number;
  startsAt: string;
  expiresAt: string;
  perMemberLimit: number;
  status: ActiveStatus;
}

export interface MemberCoupon {
  id: string;
  status: 'AVAILABLE' | 'USED' | string;
  rechargeId: string | null;
  snapshot: {
    name: string;
    planId: string;
    giftQty: number;
    startsAt: string;
    expiresAt: string;
    waterType: WaterType;
    fulfillMode: FulfillMode;
    price: number;
    fixedQty: number;
  };
}

export interface DepositSummaryRow {
  containerType: ContainerType;
  paidQty: number;
  paidAmount: number;
  heldQty: number;
  pendingDamageQty: number;
  pendingDamageAmount: number;
  refundableQty: number;
  refundableAmount: number;
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
export type InventorySource = 'AVAILABLE' | 'TRANSIT' | 'INSPECTING' | 'ABNORMAL' | 'MEMBER' | 'DAMAGED' | 'EXTERNAL';

export interface InventoryRequest {
  containerType: ContainerType;
  action: InventoryAction;
  reason: string;
  idempotencyKey: string;
  quantity: number;
  sourceState: InventorySource;
}

export interface InventoryBalance {
  totalQty: number;
  inStationQty: number;
  inTransitQty: number;
  memberHeldQty: number;
  inspectingQty: number;
  abnormalQty: number;
  damagedQty: number;
  scrappedQty: number;
}

export interface InventoryOperation {
  id: string;
  operationNo: string;
  containerType: ContainerType;
  action: InventoryAction;
  sourceState: InventorySource;
  quantity: number;
  deltaTotal: number;
  memberId: string | null;
  reason: string;
  operatorName: string;
  before: InventoryBalance;
  after: InventoryBalance;
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

export type CirculationBusinessType = 'TURNOVER' | 'DAMAGE_RETURN' | 'SCRAP';

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
}

export type ExportDataset =
  | 'members'
  | 'orders'
  | 'recharges'
  | 'ticket-ledgers'
  | 'deposit-ledgers'
  | 'container-ledgers'
  | 'inventory-operations';
