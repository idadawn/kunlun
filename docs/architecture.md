# Kunlun（昆仑）· 技术架构、权限与数据库设计

| 项目 | 内容 |
| --- | --- |
| 仓库名称 | `idadawn/kunlun` |
| 业务产品 | 绿麒麟·水站会员管理系统（绿麒麟水站｜小分子团弱碱活性水） |
| 品牌 Slogan | **鲜活每一滴，好水到你家** |
| 技术底座 | 基于 `Qian` 平台插件规范 + `Kun`（.NET 10 云原生框架）+ `@idadawn/yue` React 组件库 |
| 命名规范 | `.NET` 命名空间与包前缀 `Kunlun.*` · 插件 ID `kunlun.waterstation` · 前端包前缀 `@kunlun/*` |

---

## 1. Monorepo 目录结构

```text
kunlun/
├── Kunlun.slnx                          # .NET 10 解决方案
├── Directory.Build.props                # .NET 统一编译配置
├── Directory.Packages.props             # NuGet 中央包版本管理 (Kun / Qian / EF Core)
├── pnpm-workspace.yaml                  # 前端工作区 (packages/*, apps/*)
├── turbo.json                           # Turborepo 并行构建与缓存配置
├── package.json                         # 顶层工作区描述 ("name": "kunlun")
├── docs/
│   ├── PRD.md                           # 产品需求文档
│   └── architecture.md                  # 技术架构、权限与四账数据库设计（本文档）
├── deploy/nginx.conf                    # 生产路由：两个 React 构建产物 + /api 反向代理
├── scripts/                             # Vite 干净路由插件、构建产物检查与路由/价目表测试
├── services/
│   ├── Kunlun.WaterStation/             # .NET 10 核心业务插件与宿主 (id: kunlun.waterstation)
│   └── Kunlun.WaterStation.Tests/       # 集成与验收测试 (AC-01 ~ AC-20)
├── packages/
│   ├── shared/                          # @kunlun/shared：类型、API 客户端、路由表、四账公式、价目表模型与权限常量
│   └── ui/                              # @kunlun/ui：品牌样式、图标、弹窗、登录门禁、套餐选择、地址簿与员工业务弹窗
└── apps/
    ├── admin-pc/                        # @kunlun/admin-pc：管理端 PC（React 18 + Vite + React Router）
    └── mini-app/                        # @kunlun/mini-app：员工端 /staff 与会员端 /member H5（React 18 + Vite）
```

---

## 2. 认证与权限体系（Auth & RBAC）

### 2.1 三端登录方式

三端统一使用用户名和密码。管理端仅接受 ADMIN，员工端接受 STAFF，会员端接受 MEMBER。用户名不区分大小写，支持 3–32 位字母、数字、点、横线和下划线；密码 8–128 位，以随机盐 PBKDF2-SHA256（600,000 次）保存，兼容升级前员工密码摘要。不存在手机号免密登录入口。

首次部署显式提供数据库连接、至少 32 字节 JWT 签名密钥及初始化管理员用户名/密码；只在员工表为空时创建管理员。默认不写演示账号。已有员工使用原工号作为用户名，会员由授权员工在会员详情中设置账号。修改密码、重置凭证、退出登录和停用账号均递增 token_version，服务端每次请求检查状态和版本。登录按来源 IP 限流，页面不保存密码。

开发启动必须显式提供环境配置，不自动读取 `.env.local`。测试仅使用 `KUNLUN_TEST_DATABASE_URL`，自行创建独立测试数据库并在结束后删除。前端源码只在 `apps/*/src` 与 `packages/*/src` 中维护，不再保留手写 HTML 页面。

### 2.2 四级内置角色与权限码（`kunlun.waterstation:<resource>:<action>`）

| 角色标识 | 角色名称 | 默认权限范围 |
| --- | --- | --- |
| `MEMBER` | 水站会员 | 无后台权限码；服务端强制按当前令牌中的 `member_id` 执行数据隔离 |
| `COURIER` | 送水员 | `member:read`、`order:accept`、`order:fulfill`、`deposit:collect` |
| `CLERK` | 驻店店员 | 含送水员全部权限 + `member:write`、`recharge:create`、`order:create`、`pickup:verify`、`container:register`、`deposit:refund_apply` |
| `ADMIN` | 站长/管理员 | `kunlun.waterstation:*`（含 `deposit:refund_approve`、`order:correct`、`plan:manage`、`report:export`、`staff:manage`） |

---

## 3. 四账分离数据库设计（PostgreSQL 16）

数据库 Schema 统一为 `plugin_kunlun_waterstation`，当前宿主使用配置的单水站租户 ID，新增业务接口按租户与会员身份过滤；数据库未部署 RLS 策略，不能将本实现视为已验收的多租户隔离平台。

### 3.1 10 张核心表清单

1. **`staff`（员工表）**：`id`, `tenant_id`, `staff_no`, `name`, `phone`, `role`, `permissions`, `status`, `token_version`, `wx_openid`
2. **`members`（会员表）**：`id`, `tenant_id`, `member_no`, `name`, `phone`, `wx_openid`, `default_address`, `status`, `source`
3. **`recharge_plans`（优惠方案表）**：`id`, `tenant_id`, `name`, `water_type`(`BUCKET_18_9L`/`BAG_7_5L`), `fulfill_mode`(`DELIVERY`/`PICKUP`), `price`(`NUMERIC(10,2)`), `buy_qty`, `gift_qty`, `status`
4. **`container_configs`（容器标准与总账表）**：
   - `tenant_id`, `container_type`(`BUCKET`/`BAG`), `unit_deposit`, `total_qty`, `in_station_qty`, `member_held_qty`, `damaged_qty`, `scrapped_qty`, `warn_threshold`
   - **恒等式约束**：`CHECK (total_qty = in_station_qty + member_held_qty + damaged_qty)`，即现存总量 = 门店可用 + 会员持有 + 待报废
5. **`member_ticket_accounts`（会员四类水票账户表）**：
   - 唯一键：`(tenant_id, member_id, water_type, fulfill_mode)`
   - 字段：`available_buy_qty`, `available_gift_qty`, `reserved_qty`, `used_qty`
   - **防透支约束**：`CHECK (available_buy_qty >= 0 AND available_gift_qty >= 0 AND reserved_qty >= 0)`
6. **`ticket_ledgers`（水票变动流水表）**：只增不改，记录充值购水、充值赠水、下单预占、取消释放、交付核销及关联纠错。
7. **`recharge_orders`（水费实收单）**：保存 `paid_amount`、`pay_method`、`idempotency_key` 以及充值当时的完整方案快照 `plan_snapshot (JSONB)`。
8. **`deposit_lots` & `deposit_refunds`（押金收款批次表与退款记录表）**：
   - 按收款批次记录当时的 `unit_price` 与 `remaining_qty`，确保修改押金单价后，历史押金严格按原收取单价退还（满足 `AC-12`）。
   - **可退押金数量公式**：`max(0, 已交未退押金总数量 - 当前实际持有容器数量)`。
9. **`water_orders`（水单主表）**：
   - 保存下单预占数量 `order_qty`、配送地址快照 `address_snapshot`、6 位自提取水码 `pickup_code`；
   - 交付时记录实际交付量 `actual_deliver_qty`、**满桶领出 `full_out_qty (N)`**、**空桶收回 `empty_in_qty (M)`** 及差异原因。
10. **`member_container_holdings` & `container_ledgers`（会员容器持有表与桶袋流水表）**：
    - 每次交付或独立登记按 `会员持有变化 = N - M` 更新持有量，并联动校验押金覆盖。


## 4. 固定套餐与批次权益实现

实际实现位于 `Operations/MembershipEndpoints.cs` 和 `Operations/TicketBatches.cs`。当前水票汇总仍保存在 `members` 的四类可用/预占字段中；上述早期 `member_ticket_accounts` 分表设计尚未采用。批次是新充值的权益来源，汇总字段与批次分配在同一事务内更新。

| 表 | 职责 |
| --- | --- |
| `ticket_batches` | 原充值金额、固定数量、付费/赠票剩余与预占、历史余额标识、退款终态 |
| `order_ticket_allocations` | 水单到批次的付费/赠票分配，以及核销和取消来源 |
| `coupon_templates` | 优惠券配置与每会员领取次数 |
| `member_coupons` | 发券快照、所属会员、核销状态与关联充值单 |
| `recharge_refunds` | 每批次唯一退清记录，原价退款及赠票收回的审计依据 |
| `membership_migrations` / `finance_migrations` | 按租户一次性初始化历史余额和升级套餐，重复启动不重复入账 |

充值、发券、退款先锁定业务幂等键，再锁会员行；水单创建锁会员后分配批次，取消/核销锁订单再锁会员，不在退款中反向锁水单。批次按创建时间和 ID 排序。付费票还被其他未完成订单占用时，不允许提前消费同批次赠票。退款与下单竞争同一会员行，只有一方可以占用相同余额。

默认套餐是自提 100/16、500/95，配送 100/13、500/70；`buy_qty` 表示全部固定付费票。历史 `gift_qty` 字段保留兼容原单，新方案设置为零，额外赠水由券生成。`recharge_orders.plan_snapshot`、`coupon_snapshot` 保存交易条件，改价不改变退款计价。退款按批次一次退清，最终金额舍入到分，无重复分次舍入损失。

管理端为 `apps/admin-pc` React 应用；员工端与会员端为 `apps/mini-app` React H5 应用，按路径加载对应端的代码与样式。浏览器端使用 `@kunlun/shared` 的 `KunlunApi` 作为 API 入口，`@kunlun/ui` 提供登录门禁、弹窗栈以及充值、发券、退款、履约、押金和领还等员工业务弹窗，管理端和员工端共用；点单组件见 5.2。浏览器入口继续保留；新增 `apps/wechat-mini` 原生测试包，使用 `wx.request` 适配已有业务接口，按后端身份与权限渲染。同一小程序覆盖会员与员工测试流程，见 [小程序测试说明](wechat-mini.md)。它尚未发布，也未启用真实微信收款。

接口：`POST/PUT /api/plans`，`POST /api/recharges`（可选 `couponId`），`GET /api/members/{id}/ticket-batches`，`POST /api/ticket-batches/{id}/refund`，`GET/POST/PUT /api/coupon-templates`，`POST /api/coupon-templates/{id}/issue`，`GET /api/members/{id}/coupons`。退款需 `recharge:refund` 权限，仅默认授予管理员；会员查询强制本人范围。充值汇总分别返回累计收款、累计退款及水费净收。


## 5. Web 路由与部署入口

三端使用 `/admin`、`/staff`、`/member` 路径，合法页面由 `packages/shared/src/routes.ts` 定义，应用内用 React Router 导航。`scripts/vite-routes.ts` 为开发与 preview 服务器提供同一套规则：声明的页面返回 React 入口，`/` 跳转 `/admin`（H5 应用跳转 `/member`），未知页面和任何 `.html` 地址返回 404，不再兼容 `admin.html`、`#页面` 等旧链接。

构建产物为 `apps/admin-pc/dist`、`apps/mini-app/dist`，各含一个入口文档和 `/static/admin/`、`/static/h5/` 下带哈希的资源，两套资源目录不冲突，也不与 `/admin/assets` 等页面路径冲突。`deploy/nginx.conf` 按页面路由把请求分发到对应构建，`scripts/web-routes.test.mjs` 校验其正则与路由表一致；`scripts/check-production-pages.mjs` 校验构建产物。优惠券和充值共用 `@kunlun/ui` 的套餐选择器，只有启用套餐可确认；保存优惠券时后端另行锁定/校验套餐状态。


## 5.1 会员收货地址簿

`member_addresses` 保存会员的多个收货地址：`location`（收货地址：小区/街道/楼栋）、`door_no`（门牌号）、`contact_name`、`contact_phone`、`is_default`，部分唯一索引保证每位会员最多一个默认地址，每人最多 20 个。新增地址时联系人和手机号默认带出会员本人，可改为实际收货人；首个地址自动设为默认，删除默认地址时由最近修改的地址接替。`members.default_address` 保留默认地址的展示文本，会员列表、导出等既有读取方不受影响。

接口：`GET/POST /api/members/{id}/addresses`，`PUT/DELETE /api/members/{id}/addresses/{addressId}`，`POST /api/members/{id}/addresses/{addressId}/default`。会员只能维护本人地址；员工读取需 `member:read`，修改需 `member:write`。同一会员的地址变更先锁会员行。新建会员时填写的收货地址和门牌号成为首个默认地址。

配送水单提交 `addressId`（省略时使用默认地址），没有可用地址时拒绝下单；`address_snapshot` 记录地址 ID、联系人、手机号、收货地址、门牌号和完整地址文本，之后修改或删除地址不影响已下单水单。升级前只有单行文本地址的会员在启动时自动迁移为一条默认地址，门牌号留空，提示会员或员工补充。


## 5.2 点单与桶袋押金

`@kunlun/ui` 的 `OrderMenu` 是唯一的下单界面：先选「送水上门 / 到店自提」，再像点外卖一样在水品卡片上加减数量，底部购物袋显示扣票与需补押金，「选好了」后确认地址、时段或门店并提交。每个水品生成一张水单，各自带幂等键；同一次结算中已完成的步骤记在组件内，重试只补做未完成的部分。

- 会员端 `/member/order`：会员自助点单；配送按地址簿选址，自提生成取水码。
- 门店点单：员工端 `/staff/order` 与管理端「门店点单」弹窗共用 `CounterOrder`（查找或新建顾客 + `OrderMenu`）。顾客在店选「到店取水」时，提交即依次创建水单、收取需补押金、按「满桶领出 N / 换回空桶 M」交付；配送则生成待送水单。原「代开水单」表单已移除。
- 押金按 `calcDepositGap` 计算：需补个数 = max(0, 当前持有 + N − M − 押金覆盖)，押金覆盖 = 已交未退 − 待报废占用，与交付时服务端校验一致。下单时默认按「有多少空桶换多少」估算并提示；配送交付弹窗按实际换回数量计算，不足时可选收款方式先收押金再交付，交付时服务端仍会拦截押金不足。

## 5.3 列表分页与筛选

`GET /api/members`、`GET /api/orders` 与 `GET /api/ledgers/recharges|recharge-refunds|deposits|containers` 接受 `page`、`pageSize`（1–100，默认 20）。传入任一参数时返回 `{ rows, total, page, pageSize }`（与 `/api/containers/holdings|circulation|damages` 相同），`page`/`pageSize` 为服务端实际采用的值；都不传时仍返回旧的数组（会员、水单最新 50 条，流水最新 30 条），兼容会员选择器等调用方。筛选在服务端完成：会员 `q`（编号/姓名/手机号）、`status`、`water`（持有该类水票）；水单 `q`（单号、取水码、地址快照联系人/手机号/地址、会员姓名/手机号）、`status`、`mode`、`memberId`、`pickupCode`；充值、水费退款与押金流水 `q`（含会员编号与手机号）；水单与这三类流水另有 `from`（含）/`to`（不含）时间区间；充值与水费退款流水 `payMethod`；押金流水 `flowType`（`COLLECT` / `REFUND` / `DEDUCT`）与 `containerType`；容器流水 `containerType`。充值流水带出所用优惠券和退清状态；押金流水带出会员编号和收付方式，退押金登记的退款方式存于 `deposit_refunds.pay_method`（此前登记的退款为空）。`q` 中的 `%`、`_` 按字面匹配。管理端会员管理、水单管理、水费充值、押金管理、桶袋台账的表格和员工端会员查询均按页加载；充值、发券、押金、开单、领还和破损登记弹窗用 `@kunlun/ui` 的 `MemberPicker` 按姓名、手机号或会员编号向服务端检索会员，预选会员按 ID 读取档案，不依赖页面已加载的会员列表。`KunlunApi` 的 `membersPage`、`ordersPage` 及四个流水方法始终带 `page`。


## 6. 袋桶库存、周转与报废扣押

`ContainerInventory` 只接收 `RECEIVE` / `SCRAP`：入库计入门店可用，报废从门店可用扣减，不再区分报废来源。库存操作保留 before/after 快照，现存总量恒等于门店可用、会员持有和待报废（会员破损归还、尚未扣押金）之和，累计报废独立累计。旧库中的在途、待检、异常和门店破损数量在启动时并入门店可用（总量不变）后删除相应列。

`ContainerCirculation` 管理会员破损归还和确认报废。`container_damages` 保存原押金批次及金额、状态、两次操作的幂等回执。破损归还将 `deposit_lots.reserved_damage_qty` 增加；正常退款、领用覆盖额和可退押金展示都排除暂占数量。报废才减少批次 `remaining_qty`、增加 `deducted_qty` 并释放暂占，同时扣会员押金、更新库存并写 `container_ledgers`。财务流水以 `DEDUCT` 区别于 `REFUND`，对账包含累计扣押。

所有写入使用同一事务；锁序为幂等请求、会员、破损记录（适用时）、容器、押金批次。门店报废在容器锁下排除会员待报废数量。会员破损金额不足时拒绝整笔；不同幂等键也不能重复处理已报废记录。新迁移不追溯扣除既有旧库存流水中的押金。

路由 `/admin/inventory` 和 `/admin/assets` 独立呈现，主 HTML 与 `assets/inventory.js` 为唯一前端维护源，构建同步到两端。会员持有、周转流水、破损记录由服务器过滤和分页，避免仅展示最近记录造成台账遗漏。

## 6.1 退款申请与审核

`refund_requests` 记录所有退款申请：`kind`（`DEPOSIT` / `RECHARGE`）、会员、容器与数量或充值批次、申请时估算金额、退款方式、原因、`status`（`PENDING` / `APPROVED` / `REJECTED`）、申请人与审核人、审核备注、实际退款单号与金额。部分唯一索引保证同一充值批次最多一笔待审核申请。

- `POST /api/refund-requests`：提交申请（带幂等键）。押金需 `deposit:refund_apply` 或 `deposit:refund_approve`，申请数量不得超过 已交未退 − 持有 − 待报废 − 其他待审核数量；水费需 `recharge:create` 或 `recharge:refund`，原因必填，批次须属于该会员且可退。只写申请，不动账。
- `GET /api/refund-requests?status&kind&q&page&pageSize`：分页列表（需 `member:read`），带会员、容器或批次信息。
- `POST /api/refund-requests/{id}/approve`：审核通过，押金需 `deposit:refund_approve`，水费需 `recharge:refund`。先锁会员、再锁申请，在同一事务内调用与直接退款相同的 `ExecuteDepositRefund` / `ExecuteRechargeRefund`（幂等键 `refund-request:{id}`），再写回审核结果；重复通过返回原结果，已驳回的返回 409。
- `POST /api/refund-requests/{id}/reject`：驳回，原因必填，不动账；已通过的不能驳回。
- 原 `POST /api/deposits/refund`、`POST /api/ticket-batches/{id}/refund` 仅对有审核权限的账号开放，成功后由 `RefundRequests.RecordDirect` 补记一笔 `APPROVED` 申请（如该批次已有待审核申请则直接将其通过）。
- `GET /api/members/{id}/deposit-summary` 增加 `pendingRefundQty`，`GET /api/members/{id}/ticket-batches` 增加 `pendingRequestNo`。

报废扣押可选免扣：`POST /api/containers/damages/{id}/scrap` 的 `deductDeposit=false` 时只释放押金批次的 `reserved_damage_qty`，不减少批次剩余、不扣会员押金；`container_damages.deposit_waived` 标记，周转流水业务类型为 `SCRAP_WAIVED`、扣押金额 0。财务汇总、押金流水和导出中的扣押统计排除免扣记录，剩余押金 = 累计收押 − 累计退押 − 累计报废扣押 仍成立。



## 原生小程序测试支付（2026-10-29）

`MiniPayments` 在显式 Mock 模式、Development/Testing 环境及名称包含 test 的隔离数据库中启用。Disabled 是默认值，不创建测试表。会员创建待支付单（套餐，或按水品零售价补差的零售行），服务端确定整数分金额和不可变快照；模拟成功在同一事务内锁会员、锁支付单并写支付状态、充值单、水票批次、票据流水及可用余额，零售每行各记一笔不关联套餐的充值单和同方式水票批次。`pay_method=MOCK` 区别于线下微信记账。APIv3 直连/公钥验签为已确认的后续真实支付方案，当前服务端不支持 Wechat 模式。详见 [小程序测试说明](wechat-mini.md)。
