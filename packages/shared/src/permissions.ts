export const KUNLUN_PERMISSIONS = {
  MemberRead: 'kunlun.waterstation:member:read',
  MemberWrite: 'kunlun.waterstation:member:write',
  /** 补录会员上系统前的套餐余量、押金和手里的桶袋；默认只有管理员有，不随手机端功能开通。 */
  MemberOpening: 'kunlun.waterstation:member:opening',
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

const P = KUNLUN_PERMISSIONS;

/** Plain names for permission codes, in the order the console lists them. */
export const PERMISSION_TITLES: Readonly<Record<PermissionCode, string>> = {
  [P.MemberRead]: '查询会员',
  [P.MemberWrite]: '新建与修改会员',
  [P.MemberOpening]: '补录会员上系统前的数据',
  [P.RechargeCreate]: '水费充值登记',
  [P.RechargeRefund]: '退清水费',
  [P.DepositCollect]: '收押金',
  [P.DepositRefundApply]: '申请退押金',
  [P.DepositRefundApprove]: '审核退押金',
  [P.OrderCreate]: '门店点单',
  [P.OrderAccept]: '接单配送',
  [P.OrderFulfill]: '确认交付',
  [P.PickupVerify]: '自提核销',
  [P.ContainerRegister]: '登记领还',
  [P.ContainerInventoryManage]: '管理桶袋库存',
  [P.PlanManage]: '水品与套餐设置',
  [P.ReportExport]: '经营报表与导出',
  [P.StaffManage]: '员工与权限管理',
};
