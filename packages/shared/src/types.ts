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
  mustChangePassword?: boolean;
}

export interface CurrentUser {
  mustChangePassword?: boolean;
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
  /** When, by whom and why the member was disabled; null while the member is active. */
  disabledAt?: string | null;
  disabledBy?: string | null;
  disableReason?: string | null;
}

/** A member's status after 停用 / 重新启用. */
export type MemberStatusResult = Pick<MemberProfile, 'id' | 'status' | 'disabledAt' | 'disabledBy' | 'disableReason'>;

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
  /** 交付备注：顾客没交或没交够押金（交了几个、欠几个），损坏的桶袋赔没赔、不赔的原因；都没有为空。 */
  overrideReason?: string | null;
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
  /** 顾客没交或没交够押金照样交付，差额记成欠押金；需要收押金权限，押金够时服务端不理会。 */
  forceCreditOverride?: boolean;
  /** 交付备注（交没交押金、损坏的桶袋赔没赔），记欠押金时必填；有就存进水单和袋桶台账，500 字以内。 */
  overrideReason?: string | null;
  /** 交付时损坏的桶袋个数、顾客赔不赔、不赔的原因；不赔付按审核开关等管理员批准。 */
  damagedQty?: number;
  damageCompensated?: boolean | null;
  damageReason?: string | null;
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
  /** Deposits collected in the system; deposits recorded from before it are `depositOpeningTotal`. */
  depositCollectedTotal: number;
  depositTransferTotal: number;
  depositCollectCount: number;
  depositRefundedTotal: number;
  depositDeductedTotal: number;
  depositDeductCount: number;
  depositRefundCount: number;
  /** Deposits members paid before the station used the system, recorded later (上系统前已收). */
  depositOpeningTotal: number;
  depositOpeningCount: number;
  unrefundedDepositPoolTotal: number;
  /** Containers the unrefunded deposit pays for, those awaiting a scrap decision included. */
  unrefundedDepositQty: number;
  /** 上系统前 + 累计收押 − 累计退押 − 累计扣押; equals the pool when the books agree. */
  netDepositFromFlows: number;
  reconciledZeroDiff: boolean;
  /** Unused paid tickets of active recharge batches at their original paid price: what refunding them all would pay back. */
  unusedRechargeValue: number;
  unusedPaidTicketQty: number;
  /** Gift tickets still on active recharge batches; a refund takes them back without paying for them. */
  unusedGiftTicketQty: number;
  /** Tickets with no recorded price (old opening balances, packages recorded as 套餐不清楚), left out of every value. */
  legacyTicketQty: number;
  /** What is left of packages bought before the system, at the price recorded with them. Not in the recharge receipts. */
  openingUnusedValue: number;
  openingPaidTicketQty: number;
  /** Refunds of packages bought before the system; included in `rechargeRefundedTotal`. */
  openingRefundedTotal: number;
  openingTransferred: number;
  openingRefundCount: number;
  /** Money members could still ask back: the unrefunded deposit, `unusedRechargeValue` and `openingUnusedValue`. Not income. */
  potentialRefundTotal: number;
  /**
   * Water fees members have used up of recharges made in the system: receipts minus their refunds minus `unusedRechargeValue`.
   * So 水费净收 = this + `unusedRechargeValue` − `openingRefundedTotal`.
   */
  rechargeEarnedTotal: number;
  /** 费用支出（买桶袋、配件耗材、维修等），作废的不算。 */
  expenseTotal: number;
  expenseCount: number;
  /** Net recharge receipts minus expenses: what the water fees leave after the station's spending. Deposits are neither. */
  rechargeNetAfterExpenses: number;
  completedOrderCount: number;
  waterFulfilledTotalQty: number;
  generatedAt: string;
}

export type OperatingPeriod = 'today' | 'week' | 'last-week' | 'month' | 'last-month' | 'year' | 'last-year';

export interface OperatingPoint {
  label: string;
  receipts: number;
  buckets: number;
  bags: number;
  deliveries: number;
  pickups: number;
  newMembers: number;
}

export interface OperatingReport {
  start: string;
  end: string;
  grain: 'hour' | 'day' | 'month';
  cash: ExpenseSummary;
  /** Only available with report permission. Includes empty slots up to the current hour, day or month. */
  activity: { trend: OperatingPoint[]; redeemedValue: number } | null;
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
  transferredAmount: number;
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

/** OPENING: a deposit paid before the station used the system, recorded afterwards; not collected that day. */
export type DepositFlowType = 'TRANSFER' | 'COLLECT' | 'REFUND' | 'DEDUCT' | 'OPENING';

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
  damagedReturnQty: number;
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

/**
 * How a package bought before the station used the system was recorded; carried by OPENING batches.
 * Members read batches too, so the staff note and who entered it are only on the opening entry (`OpeningEntry`).
 */
export interface OpeningSnapshot {
  entryNo: string;
  planId: string | null;
  planName: string | null;
  name: string;
  waterLabel: string;
  fulfillMode: FulfillMode;
  /** What the member paid for the package back then; 0 when the package is not known (套餐不清楚). */
  paidAmount: number;
  packageQty: number | null;
  enteredAt: string;
}

export interface TicketBatch {
  id: string;
  /** PURCHASE: a recharge; LEGACY: a balance moved from the old member columns; OPENING: a package recorded from before the system. */
  source: 'PURCHASE' | 'LEGACY' | 'OPENING' | string;
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
  /** OPENING batches only; null for every other batch (and absent from older servers). */
  opening?: OpeningSnapshot | null;
  /** An OPENING batch no order or refund has used yet, which can still be removed as a mistake. */
  removable?: boolean;
}

/** 补录（期初）：会员上系统前买的一个套餐。带 batchId 时改一笔已补录的余额：remaining 改成现在还剩的数，remove 删掉没用过的。 */
export interface OpeningTicketInput {
  batchId?: string;
  waterType?: WaterType;
  fulfillMode?: FulfillMode;
  planId?: string;
  /** What was paid for the package back then; 0 when it is not known, which leaves the tickets without a refund price. */
  paidAmount?: number;
  packageQty?: number;
  remaining: number;
  remove?: boolean;
}

/**
 * The deposit a member paid before the system for one container: how many and the total paid (`amount`, split evenly over them to
 * the cent); older clients send `unitPrice` instead. 0 removes an untouched entry.
 */
export interface OpeningDepositInput { containerType: ContainerType; quantity: number; amount?: number; unitPrice?: number }
/** How many of one container the member holds now. */
export interface OpeningHoldingInput { containerType: ContainerType; quantity: number }

export interface SaveOpeningBody {
  idempotencyKey: string;
  tickets?: OpeningTicketInput[];
  deposits?: OpeningDepositInput[];
  depositAmount?: number;
  expectedDepositAmount?: number;
  holdings?: OpeningHoldingInput[];
  note?: string;
}

export interface OpeningDepositAmount { quantity: number; unitPrice: number; amount: number }

/** One change an opening entry made, with the figure before and after. */
export type OpeningItem =
  | { kind: 'TICKETS'; action: 'CREATE' | 'ADJUST' | 'REMOVE'; batchId: string; waterType: WaterType; name: string; fulfillMode: FulfillMode; unit: string; paidAmount?: number; packageQty?: number | null; before: number; after: number }
  | { kind: 'DEPOSIT_TOTAL'; before: number; after: number }
  | { kind: 'DEPOSIT'; action: 'CREATE' | 'ADJUST' | 'REMOVE'; containerType: ContainerType; depositNo: string; before: OpeningDepositAmount | null; after: OpeningDepositAmount | null }
  | { kind: 'HOLDING'; action: 'SET'; containerType: ContainerType; before: number; after: number; coveredQty: number };

/** One opening entry (补录记录): what was recorded or corrected in one go, by whom and when. */
export interface OpeningEntry {
  id: string;
  entryNo: string;
  memberId: string;
  note: string | null;
  operatorName: string;
  createdAt: string;
  items: OpeningItem[];
}

/** A member's opening deposit of one container; `locked` once part of it was refunded, deducted or held for a damage. */
export interface OpeningDeposit {
  containerType: ContainerType;
  quantity: number;
  unitPrice: number;
  amount: number;
  depositNo: string;
  remainingQty: number;
  locked: boolean;
}

export interface MemberOpeningRecord {
  depositAmount: number;
  lockedDepositAmount: number;
  deposits: OpeningDeposit[];
  /** Newest first. */
  entries: OpeningEntry[];
}

export interface DepositSummaryRow {
  pool: { total: number; available: number; required: number; shortfall: number; reserved: number; pending: number; pendingCollect: number };
  damageQty: number;
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
  /** Deposit staff took that waits for an admin to approve: it covers containers already, but is booked (and refundable) only once approved. */
  pendingCollectQty: number;
  pendingCollectAmount: number;
  /** The deposit not held for a damage, oldest first: refunds take from the front at these prices. Absent from older servers. */
  lots?: Array<{ unitPrice: number; quantity: number }>;
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
  /** 新购花了多少钱：填了就同时记一笔「买桶袋」费用支出（需要 expense:manage），须一并给付款方式。 */
  cost?: number;
  payMethod?: PayMethod;
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
  /** The 买桶袋 expense recorded with a 新购 that said what it cost. */
  expense?: { expenseNo: string; amount: number; payMethod: PayMethod } | null;
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

/**
 * OPENING: containers a member already had before the system, written down (or corrected) by an opening entry.
 * RECEIVE / STORE_SCRAP: the store's own 新购 and 门店报废, from the stock records; no member is involved.
 */
export type CirculationBusinessType = 'TURNOVER' | 'DAMAGE_RETURN' | 'SCRAP' | 'SCRAP_WAIVED' | 'OPENING' | 'RECEIVE' | 'STORE_SCRAP';

export interface CirculationRow {
  damagedReturnQty: number;
  /** The ledger number, or the stock record's number for RECEIVE / STORE_SCRAP. */
  ledgerNo: string;
  /** Empty for the store's own RECEIVE / STORE_SCRAP. */
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
  /** How many a RECEIVE added to the store; 0 otherwise. */
  receivedQty: number;
  /** 店里 before → after a RECEIVE / STORE_SCRAP; null on member rows. */
  storeBefore: number | null;
  storeAfter: number | null;
}

export type DamageStatus = 'PENDING' | 'SCRAPPED';

export interface ContainerDamageRow {
  handoverOrderNo?: string | null;
  feePaid?: boolean | null;
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
  /** 交过的押金不够扣的个数（如欠着押金），报废时这些没有押金可扣。 */
  uncoveredQty: number;
  /** 登记时为没押金的那几个写的备注：报废费用给没给、为什么没交。 */
  uncoveredNote: string;
}

/** GIFT: tickets given away by hand on a recharge while gifts are reviewed, whoever typed them in. */
/** 审核的种类：押金退款、水费退款、充值赠送、员工收的押金、交付时登记的损坏不赔付。 */
export type RefundKind = 'DEPOSIT' | 'RECHARGE' | 'GIFT' | 'COLLECT' | 'DAMAGE';
export type RefundRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/**
 * 审核开关：充值时手动赠送、店员退押金和退水费、员工收的押金、交付时登记的损坏不赔付要不要管理员审核。
 * 赠送、收押金和损坏不赔付不分谁办的都要审核（门店共用一个管理员账号）；管理员自己办理的退款直接生效。
 */
export interface ReviewSettings {
  giftReview: boolean;
  refundReview: boolean;
  /** 员工收的押金（含交付时收的）先记待审核，管理员核对到账批准后才算数。 */
  depositReview: boolean;
  /** 交付时损坏的桶袋选了不赔付，要管理员批准。 */
  damageReview: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** 审核申请：押金退款、退清充值剩余权益、店员手动赠送的水票、员工收的押金或交付时的损坏不赔付；不需要审核时当场记为已通过。 */
export interface RefundRequestRow {
  settlementNo: string | null;
  settlementCharged: boolean | null;
  settlementAmount: number | null;
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
  /** What the applicant typed in when it differs from the books; the reviewer then confirms the amount. */
  requestedAmount?: number | null;
  /** Pending water refunds: the remaining paid tickets at the original price now (tickets stay usable during review). */
  currentAmount?: number | null;
  /** A deposit staff took: the unit price it was taken at, booked at that price once approved. */
  unitPrice: number | null;
  /** A damage waiver: the order handed over when the damage was found. */
  orderNo: string | null;
}

export interface RefundRequestQuery extends PageQuery {
  memberId?: string;
  status?: RefundRequestStatus;
  kind?: RefundKind;
  q?: string;
}

/** `amount`: what is actually paid back; without it the books decide (remaining paid tickets or the deposit at the original price). */
export type ApplyRefundBody =
  | { kind: 'DEPOSIT'; memberId: string; containerType?: ContainerType; quantity?: number; payMethod: PayMethod; reason?: string; idempotencyKey: string; amount?: number }
  | { kind: 'RECHARGE'; memberId: string; batchId: string; payMethod: PayMethod; reason?: string; idempotencyKey: string; amount?: number };

/**
 * One container in a settlement. Of what the member holds, `returned` came back good and `damaged` broken; the rest stays out.
 * `waiveDamage`: the station bears the broken ones. `unreturned`: CHARGE keeps the deposit of the rest (charging the standard
 * deposit for any without one); KEEP leaves them with the member to bring back later, taking any deposit owed from the refund.
 */
export interface SettlementContainerInput {
  containerType: ContainerType;
  returned: number;
  damaged: number;
  waiveDamage: boolean;
  unreturned: 'CHARGE' | 'KEEP';
}

export interface SettlementTicketLine {
  transferred?: number;
  batchId: string;
  name: string;
  waterType: WaterType;
  unit: string;
  remainingBuy: number;
  remainingGift: number;
  /** The remaining paid tickets at the original price. */
  value: number;
  /** What the recharge took in: the most it may pay back. */
  paid: number;
  /** What is paid back for it. */
  amount: number;
  refundNo: string | null;
}

export interface SettlementContainerLine {
  containerType: ContainerType;
  name: string;
  unit: string;
  /** The current standard, charged for containers without a deposit. */
  unitDeposit: number;
  held: number;
  /** Containers the member's deposit covers (not held for an earlier damage). */
  covered: number;
  returned: number;
  damaged: number;
  waiveDamage: boolean;
  unreturned: number;
  unreturnedMode: 'CHARGE' | 'KEEP';
  /** Containers without a deposit that need one (to keep it, or to stay out), taken from the refund at the standard price. */
  offsetQty: number;
  offsetAmount: number;
  damageDeducted: number;
  /** Broken ones the station bears that never had a deposit. */
  damageUncovered: number;
  chargeDeducted: number;
  keptQty: number;
  keptDeposit: number;
  refundQty: number;
  /** The deposit of the containers refunded, at the original prices. */
  refundValue: number;
  /** What is paid back for them. */
  refundAmount: number;
  refundNo: string | null;
  offsetNo: string | null;
  scrapNos: string[];
  pendingDamageQty: number;
  pendingDamageAmount: number;
}

/** 退款结算单: before it is done (preview) the numbers and who/when are null. */
export interface DamageDecision { reference: string; charge: boolean }
export interface SettlementSlip {
  revision?: string;
  pool?: { before: number; kept: number; charges: number; transfer: number; supplement: number; refund: number; transferNo?: string; collectionNo?: string; refundNo?: string };
  damages?: Array<{ reference: string; name: string; quantity: number; value: number; reason: string; charge: boolean | null }>;
  id: string | null;
  settlementNo: string | null;
  memberId: string;
  memberName: string;
  memberNo: string;
  payMethod: PayMethod | null;
  reason: string | null;
  operatorName: string | null;
  createdAt: string | null;
  /** What the books say: water refunds plus deposit refunds, less deposit owed. Negative when the member owes. */
  computedAmount: number;
  /** What is actually paid back (negative: what the member pays). */
  amount: number;
  tickets: SettlementTicketLine[];
  containers: SettlementContainerLine[];
  notes: string[];
}

export interface SettlementPreview {
  slip: SettlementSlip;
  /** The amounts the settlement can book: refunds down to nothing, water refunds up to what each recharge took in. */
  range: { min: number; max: number };
  /** Why the amount asked for cannot be booked; the slip then shows the computed amount. */
  amountError: string | null;
  /** Why the member cannot be settled now (open orders, refunds under review, nothing to settle). */
  blockers: string[];
}

export interface SettlementRequest {
  damageDecisions?: DamageDecision[];
  expectedRevision?: string;
  idempotencyKey: string;
  payMethod: PayMethod;
  containers: SettlementContainerInput[];
  amount: number;
  /** The computed total the counter saw; the server refuses if the books moved meanwhile. */
  expectedAmount: number;
  reason?: string;
}

/** 费用支出类别：买桶袋、配件耗材、维修、其他。 */
export type ExpenseCategory = 'CONTAINER' | 'PARTS' | 'REPAIR' | 'OTHER';
export type ExpenseStatus = 'ACTIVE' | 'VOIDED';

/** 一笔费用支出；登记错了作废（不删除），作废的不计入统计。 */
export interface Expense {
  id: string;
  expenseNo: string;
  category: ExpenseCategory;
  item: string;
  quantity: number;
  amount: number;
  payMethod: PayMethod;
  /** The purchase date (YYYY-MM-DD, Beijing), which decides the period it counts in. */
  spentOn: string;
  remark: string;
  /** Set when the containers went into stock (a 新购 with a cost, or a 买桶袋 expense that named them): which container, and that 新购's number. */
  containerType: ContainerType | null;
  inventoryOperationNo: string | null;
  status: ExpenseStatus;
  operatorName: string;
  createdAt: string;
  voidedBy: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface ExpenseQuery extends LedgerQuery {
  category?: ExpenseCategory;
  status?: ExpenseStatus;
}

export interface CreateExpenseRequest {
  category: ExpenseCategory;
  item: string;
  amount: number;
  payMethod: PayMethod;
  idempotencyKey: string;
  quantity?: number;
  /** YYYY-MM-DD; today when omitted. */
  spentOn?: string;
  remark?: string;
  /** 买桶袋 only: which container was bought. `quantity` is added to the store as a 新购 (needs the inventory permission too); left out, only the money is recorded. */
  containerType?: ContainerType;
}

/** 一段时间的收支：费用支出与分类（不含作废的），同期水费实收、退款、净收，结余 = 水费净收 − 费用支出。押金不算在内。 */
export interface ExpenseSummary {
  transferred: number;
  expenseTotal: number;
  expenseCount: number;
  voidedCount: number;
  categories: Array<{ category: ExpenseCategory; total: number; count: number }>;
  rechargeRevenue: number;
  rechargeRefunded: number;
  rechargeNet: number;
  balance: number;
}

export type ExportDataset =
  | 'expenses'
  | 'members'
  | 'orders'
  | 'recharges'
  | 'recharge-refunds'
  | 'ticket-ledgers'
  | 'deposit-ledgers'
  | 'container-ledgers'
  | 'inventory-operations';
