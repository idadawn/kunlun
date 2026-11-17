import { KUNLUN_PERMISSIONS as P, type PermissionCode } from './permissions';
import type { RoleCode } from './types';

/**
 * 员工手机端的功能目录。管理员在「移动端配置」按角色开通功能并排序：店员、送水员的权限就是已开通功能所需权限的
 * 并集（服务端 `MobileFeatures.cs` 保存同一份对照，并以它为准）；管理员在后台始终拥有全部权限，只决定手机首页显示什么。
 */
export type StaffRole = Exclude<RoleCode, 'MEMBER'>;

export const STAFF_ROLES: ReadonlyArray<{ role: StaffRole; label: string; hint: string }> = [
  { role: 'CLERK', label: '店员', hint: '驻店办理充值、押金、点单和自提' },
  { role: 'COURIER', label: '送水员', hint: '送水上门、交付水单、登记桶袋' },
  { role: 'ADMIN', label: '管理员', hint: '后台全部权限，这里只设手机首页' },
];

export const ROLE_LABELS: Readonly<Record<StaffRole, string>> = { ADMIN: '管理员', CLERK: '店员', COURIER: '送水员' };

export type MobileFeatureKey =
  | 'order' | 'orders' | 'pickup' | 'members' | 'newMember' | 'recharge'
  | 'depositCollect' | 'depositRefund' | 'movement' | 'inventory' | 'overview';

/** Staff app pages a feature opens; the bottom tab bar holds the first few of them. */
export type MobilePage = 'order' | 'orders' | 'members' | 'inventory';

export type MobileTone = '' | 'aqua' | 'gold' | 'orange' | 'violet' | 'blue';

export interface MobileFeature {
  key: MobileFeatureKey;
  label: string;
  /** Bottom-tab label of a feature with its own page. */
  tab?: string;
  /** Icon name in the @kunlun/ui sprite. */
  icon: string;
  tone: MobileTone;
  group: '日常业务' | '会员与收款' | '桶袋' | '经营';
  /** What staff can do with it, as the administrator reads it. */
  summary: string;
  /** Granted to clerks and couriers while the feature is on. */
  permissions: readonly PermissionCode[];
  page?: MobilePage;
  /** Shown as a card on the workbench rather than a shortcut. */
  card?: boolean;
  /** Set when the feature grants a high-risk permission. */
  risk?: string;
}

export const MOBILE_FEATURES: readonly MobileFeature[] = [
  {
    key: 'order', label: '门店点单', tab: '点单', icon: 'drop', tone: 'aqua', group: '日常业务', page: 'order',
    summary: '找到顾客后选水下单：到店取水当场交付、收需补押金，送水上门生成待送水单',
    permissions: [P.MemberRead, P.OrderCreate, P.OrderFulfill, P.DepositCollect],
  },
  {
    key: 'orders', label: '水单履约', tab: '水单', icon: 'truck', tone: 'orange', group: '日常业务', page: 'orders',
    summary: '接单配送、确认交付并登记领出的满桶（袋）和收回的空桶（袋）；首页列出待办水单',
    permissions: [P.MemberRead, P.OrderAccept, P.OrderFulfill, P.DepositCollect],
  },
  {
    key: 'pickup', label: '自提核销', icon: 'qr', tone: 'orange', group: '日常业务',
    summary: '会员到店报六位取水码，核销自提水单并扣水票',
    permissions: [P.PickupVerify, P.OrderFulfill],
  },
  {
    key: 'members', label: '会员查询', tab: '会员', icon: 'users', tone: '', group: '会员与收款', page: 'members',
    summary: '按姓名、手机号或会员编号查会员，看水票、押金、手里的桶袋和收货地址',
    permissions: [P.MemberRead],
  },
  {
    key: 'newMember', label: '新建会员', icon: 'user-plus', tone: '', group: '会员与收款',
    summary: '给新顾客建档、维护收货地址并设置会员登录账号',
    permissions: [P.MemberRead, P.MemberWrite],
  },
  {
    key: 'recharge', label: '水费充值', icon: 'wallet', tone: '', group: '会员与收款',
    summary: '线下收款后登记充值，按套餐到账水票，可手动赠送、申请退水费',
    permissions: [P.MemberRead, P.RechargeCreate],
  },
  {
    key: 'depositCollect', label: '收押金', icon: 'deposit', tone: 'gold', group: '会员与收款',
    summary: '会员交押金、补交押金时登记收款，押金单独记账',
    permissions: [P.MemberRead, P.DepositCollect],
  },
  {
    key: 'depositRefund', label: '退押金', icon: 'refund', tone: 'gold', group: '会员与收款',
    summary: '提交退押金申请；审核开关关闭时当场退款',
    permissions: [P.MemberRead, P.DepositRefundApply],
  },
  {
    key: 'movement', label: '登记领还', icon: 'swap', tone: 'violet', group: '桶袋',
    summary: '不下水单时单独登记会员领走、还回的桶袋',
    permissions: [P.MemberRead, P.ContainerRegister],
  },
  {
    key: 'inventory', label: '袋桶库存', tab: '库存', icon: 'box', tone: 'blue', group: '桶袋', page: 'inventory',
    summary: '查看店里、客户手里和已报废的桶袋，登记新购、报废和修改数量；首页提示店里偏少',
    permissions: [P.ContainerInventoryManage], risk: '可直接修改桶袋库存数量',
  },
  {
    key: 'overview', label: '今日经营', icon: 'chart', tone: 'aqua', group: '经营', card: true,
    summary: '首页显示待配送、待自提、今日充值和用水量等全站经营数据',
    permissions: [P.ReportExport], risk: '可查看并导出全站经营数据',
  },
];

const BY_KEY = new Map(MOBILE_FEATURES.map(f => [f.key, f]));
export const mobileFeature = (key: string) => BY_KEY.get(key as MobileFeatureKey);

/** At most this many features with a page sit in the bottom tab bar, between 工作台 and 我的. */
export const MOBILE_TAB_LIMIT = 3;

export interface MobileLayout {
  /** Known enabled features in the configured order. */
  features: MobileFeature[];
  /** The first features with a page, shown as bottom tabs. */
  tabs: MobileFeature[];
  /** Workbench shortcuts: every other non-card feature, in order. */
  shortcuts: MobileFeature[];
  has(key: MobileFeatureKey): boolean;
}

/** One layout rule for the staff app and the console preview, so the preview shows exactly what staff will see. */
export function mobileLayout(keys: readonly string[] | null | undefined): MobileLayout {
  const features = [...new Set(keys ?? [])].map(mobileFeature).filter((f): f is MobileFeature => !!f);
  const tabs = features.filter(f => f.page).slice(0, MOBILE_TAB_LIMIT);
  const shortcuts = features.filter(f => !f.card && !tabs.includes(f));
  const enabled = new Set(features.map(f => f.key));
  return { features, tabs, shortcuts, has: key => enabled.has(key) };
}

/** Permissions a clerk or courier role holds with these features on, in the canonical order. */
export function mobilePermissions(keys: readonly string[]): PermissionCode[] {
  const granted = new Set(keys.flatMap(key => mobileFeature(key)?.permissions ?? []));
  return Object.values(P).filter(code => granted.has(code));
}
