# Kunlun（昆仑）· 技术架构、权限与数据库设计

## 水品与配套容器一对一

每种水品的 `container_id` 唯一标识配套桶袋账户，`water_products.container_type` 仅描述物理形态（`BUCKET` / `BAG`）。水品容量也是配套容器规格，创建后不改容量或物理类型。不同水品即使容量相同，也不共用容器、库存或押金。新增水品与押金配置在同一事务创建，库存从零开始；编辑水品和现行押金也在同一事务保存。

为兼容已有单据，容器业务表与 API 的 `container_type` / `containerType` 字段保留原名称，但值是容器账户 ID，不能按其字符串判断桶袋类型。初始 15L 桶装水、5L 袋装水分别保留 `BUCKET`、`BAG` 作为账户 ID；新增水品使用独立 ID。客户端使用水品的 `containerId` 办理押金、领还和库存，按物理类型显示桶/袋单位。

会员持有量由 `member_container_holdings` 按容器账户核算，会员行的 `held_buckets` / `held_bags` 仅作旧只读客户端的分类汇总。交付、独立领还、退款审核、破损归还与报废全部检查对应账户；历史押金保留实收批次单价，现行标准修改不重算旧款。容器台账和导出展示对应水品名称。

`product-containers-v1` 迁移一次性把原桶/袋持有余额归入两种原始水品，重复启动不覆盖新余额。若旧库还有其他水品且同类容器已有库存、押金或业务记录，则阻止自动拆账，须先核对旧容器、押金和库存归属，不猜测分摊。升级前备份数据库，迁移期间停用旧版本写入。

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
    ├── mobile-h5/                       # @kunlun/mobile-h5：员工端 /staff 与会员端 /member H5（React 18 + Vite）
    ├── android-staff/                   # Android 员工端：打包 mobile-h5 员工页面的 WebView 容器
    ├── android-member/                  # Android 会员端：打包 mobile-h5 会员页面的 WebView 容器
    ├── android-app/                     # Android 员工与会员 H5 调试 APK（Capacitor）
    ├── ios-member/                      # 原生 iOS 会员客户端（SwiftUI）
    ├── ios-staff/                       # iOS 员工端：打包 mobile-h5 员工页面的 WKWebView 容器
    └── windows-admin/                   # Windows 管理端：打开线上 /admin 的 Electron 窗口
```

---

## 2. 认证与权限体系（Auth & RBAC）

### 2.1 三端登录方式

三端统一使用用户名和密码。管理端仅接受 ADMIN，员工端接受 STAFF，会员端接受 MEMBER。用户名不区分大小写，支持 3–32 位字母、数字、点、横线和下划线；密码 8–128 位，以随机盐 PBKDF2-SHA256（600,000 次）保存，兼容升级前员工密码摘要。不存在手机号免密登录入口。

首次部署显式提供数据库连接、至少 32 字节 JWT 签名密钥及初始化管理员用户名/密码；只在员工表为空时创建管理员。默认不写演示账号。已有员工使用原工号作为用户名，会员由授权员工在会员详情中设置账号。修改密码、重置凭证、退出登录和停用账号均递增 token_version，服务端每次请求检查状态和版本。登录按真实客户端 IP 限流（每分钟 15 次，见第 17 节），页面不保存密码。

开发启动必须显式提供环境配置，不自动读取 `.env.local`。测试仅使用 `KUNLUN_TEST_DATABASE_URL`，自行创建独立测试数据库并在结束后删除。前端源码只在 `apps/*/src` 与 `packages/*/src` 中维护，不再保留手写 HTML 页面。

### 2.2 四级内置角色与权限码（`kunlun.waterstation:<resource>:<action>`）

| 角色标识 | 角色名称 | 默认权限范围 |
| --- | --- | --- |
| `MEMBER` | 水站会员 | 无后台权限码；服务端强制按当前令牌中的 `member_id` 执行数据隔离 |
| `COURIER` | 送水员 | `member:read`、`order:accept`、`order:fulfill`、`deposit:collect` |
| `CLERK` | 驻店店员 | 含送水员全部权限 + `member:write`、`recharge:create`、`order:create`、`pickup:verify`、`container:register`、`deposit:refund_apply` |
| `ADMIN` | 站长/管理员 | `kunlun.waterstation:*`（含 `deposit:refund_approve`、`order:correct`、`plan:manage`、`report:export`、`staff:manage`、`member:opening`） |

店员、送水员的实际权限由「移动端配置」按角色开通的手机端功能决定（见第 7 节），上表为默认开通时的权限；送水员默认另含 `pickup:verify`、`container:register`（原本即可通过 `order:fulfill` 核销自提、登记领还）。

---

## 3. 四账分离数据库设计（PostgreSQL 16）

数据库 Schema 统一为 `plugin_kunlun_waterstation`，当前宿主使用配置的单水站租户 ID，新增业务接口按租户与会员身份过滤；数据库未部署 RLS 策略，不能将本实现视为已验收的多租户隔离平台。

### 3.1 10 张核心表清单

1. **`staff`（员工表）**：`id`, `tenant_id`, `staff_no`, `name`, `phone`, `role`, `permissions`, `status`, `token_version`
2. **`members`（会员表）**：`id`, `tenant_id`, `member_no`, `name`, `phone`, `default_address`, `status`, `source`
3. **`recharge_plans`（充值套餐表）**：`id`, `tenant_id`, `name`, `water_type`（水品编码，见 `water_products`）, `fulfill_mode`(`DELIVERY`/`PICKUP`), `price`(`NUMERIC(10,2)`), `buy_qty`, `gift_qty`, `status`
4. **`container_configs`（容器标准与总账表）**：
   - `tenant_id`, `container_type`(`BUCKET`/`BAG`), `unit_deposit`, `total_qty`, `in_station_qty`, `with_customers_qty`, `member_held_qty`, `damaged_qty`, `scrapped_qty`, `warn_threshold`, `counted_at`
   - **恒等式约束**：`CHECK (total_qty = in_station_qty + with_customers_qty + damaged_qty)`，即合计 = 店里 + 客户手里 + 待确认报废（会员破损归还、尚未扣押金）；`member_held_qty` 是登记在会员名下的汇总，只作客户手里的参考，不进恒等式；`counted_at` 是最近一次手动修改数量的时间
5. **`member_tickets`（会员水票余额表）**：
   - 主键：`(tenant_id, member_id, water_type, fulfill_mode)`，每种水品、每种领取方式一行，各水品互不通用
   - 字段：`available`（可用）, `reserved`（未完成水单预占）
   - **防透支约束**：`CHECK (available >= 0)`、`CHECK (reserved >= 0)`
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

实际实现位于 `Operations/MembershipEndpoints.cs`、`Operations/TicketBatches.cs` 和 `Operations/MemberTickets.cs`。水票余额保存在 `member_tickets`；升级时一次性把 `members` 原有的四类可用/预占字段搬入该表（迁移标记 `member-tickets-v1`）后删除这些字段，新库的演示会员也走同一路径。批次是新充值的权益来源，余额与批次分配在同一事务内更新；先锁会员行，再锁余额行和批次。

| 表 | 职责 |
| --- | --- |
| `ticket_batches` | 原充值金额、固定数量、付费/赠票剩余与预占、历史余额标识、退款终态 |
| `order_ticket_allocations` | 水单到批次的付费/赠票分配，以及核销和取消来源 |
| `water_products` | 水品名称、容量、包装、零售价、起送量及所用容器（`BUCKET`/`BAG`，添加后不能改）；水品编码即 `water_type` |
| `member_tickets` | 每位会员每种水品、每种领取方式的可用与预占余额 |
| `recharge_refunds` | 每批次唯一退清记录，原价退款及赠票收回的审计依据 |
| `membership_migrations` / `finance_migrations` | 按租户一次性初始化历史余额和升级套餐，重复启动不重复入账 |

充值、退款先锁定业务幂等键，再锁会员行；水单创建锁会员后分配批次，取消/核销锁订单再锁会员，不在退款中反向锁水单。批次按创建时间和 ID 排序。付费票还被其他未完成订单占用时，不允许提前消费同批次赠票。退款与下单竞争同一会员行，只有一方可以占用相同余额。

默认套餐是自提 100/16、500/95，配送 100/13、500/70；`buy_qty` 表示全部固定付费票。历史 `gift_qty` 字段保留兼容原单，新方案设置为零。优惠券已取消（2026-11-01），旧充值单的 `coupon_snapshot` 和已生成的赠票批次保留；`recharge_orders.plan_snapshot` 保存交易条件，改价不改变退款计价。退款按批次一次退清，最终金额舍入到分，无重复分次舍入损失。

管理端为 `apps/admin-pc` React 应用；员工端与会员端为 `apps/mobile-h5` React H5 应用，按路径加载对应端的代码与样式。浏览器端使用 `@kunlun/shared` 的 `KunlunApi` 作为 API 入口，`@kunlun/ui` 提供登录门禁、弹窗栈以及充值、退款、履约、押金和领还等员工业务弹窗，管理端和员工端共用；点单组件见 5.2。会员端只读，不能下单、维护地址、充值或付款。系统不接入在线支付。

接口：`POST/PUT /api/plans`（水品须存在），`POST /api/recharges`，`GET /api/members/{id}/ticket-batches`，`POST /api/ticket-batches/{id}/refund`。水品：`GET/POST /api/products`、`PUT/DELETE /api/products/{waterType}`，写操作需 `plan:manage`；新增必须选 `containerType`，编辑保留原容器，名称不可重复；有套餐、水票或水单的水品不能删除（409）。会员档案和会员列表返回 `tickets`（各水品各领取方式的非零余额，带水品名称、容器和单位）。退款需 `recharge:refund` 权限，仅默认授予管理员；会员查询强制本人范围。充值汇总分别返回累计收款、累计退款及水费净收。


## 5. Web 路由与部署入口

三端使用 `/admin`、`/staff`、`/member` 路径，合法页面由 `packages/shared/src/routes.ts` 定义，应用内用 React Router 导航。`scripts/vite-routes.ts` 为开发与 preview 服务器提供同一套规则：声明的页面返回 React 入口，`/` 跳转 `/admin`（H5 应用跳转 `/member`），未知页面和任何 `.html` 地址返回 404，不再兼容 `admin.html`、`#页面` 等旧链接。

构建产物为 `apps/admin-pc/dist`、`apps/mobile-h5/dist`，各含一个入口文档和 `/static/admin/`、`/static/h5/` 下带哈希的资源，两套资源目录不冲突，也不与 `/admin/assets` 等页面路径冲突。`deploy/nginx.conf` 按页面路由把请求分发到对应构建，`scripts/web-routes.test.mjs` 校验其正则与路由表一致；`scripts/check-production-pages.mjs` 校验构建产物。充值使用 `@kunlun/ui` 的套餐选择器，按“水品 × 领取方式”分类，只有启用套餐可确认。


## 5.1 会员收货地址簿

`member_addresses` 保存会员的多个收货地址：`location`（收货地址：小区/街道/楼栋）、`door_no`（门牌号）、`contact_name`、`contact_phone`、`is_default`，部分唯一索引保证每位会员最多一个默认地址，每人最多 20 个。新增地址时联系人和手机号默认带出会员本人，可改为实际收货人；首个地址自动设为默认，删除默认地址时由最近修改的地址接替。`members.default_address` 保留默认地址的展示文本，会员列表、导出等既有读取方不受影响。

接口：`GET/POST /api/members/{id}/addresses`，`PUT/DELETE /api/members/{id}/addresses/{addressId}`，`POST /api/members/{id}/addresses/{addressId}/default`。会员只能查看本人地址，不能修改；员工读取需 `member:read`，修改需 `member:write`。同一会员的地址变更先锁会员行。新建会员时填写的收货地址和门牌号成为首个默认地址。

前端按同一规则显示写操作（2026-11-17）：`@kunlun/ui` 的 `AddressBook`（管理端会员档案、员工端会员页）只在 `useAuth().can(member:write)` 时显示新增、编辑、删除和设为默认，点单结算的 `AddressPicker` 也只在此时显示「新增收货地址」。没有该权限的账号（默认是送水员；角色只开通「门店点单」、未开通「新建会员」时也一样）只读查看：缺门牌号提示「未填写门牌号，请联系门店补充」，没有地址时提示联系门店添加，结算页另提示可改为到店自提。

配送水单提交 `addressId`（省略时使用默认地址），没有可用地址时拒绝下单；`address_snapshot` 记录地址 ID、联系人、手机号、收货地址、门牌号和完整地址文本，之后修改或删除地址不影响已下单水单。升级前只有单行文本地址的会员在启动时自动迁移为一条默认地址，门牌号留空，提示员工补充。


## 5.2 点单与桶袋押金

`@kunlun/ui` 的 `OrderMenu` 是唯一的下单界面：先选「送水上门 / 到店自提」，再像点外卖一样在水品卡片上加减数量，底部购物袋显示扣票与需补押金，「选好了」后确认地址、时段或门店并提交。每个水品生成一张水单，各自带幂等键；同一次结算中已完成的步骤记在组件内，重试只补做未完成的部分。

- 会员端不再下单（2026-11-01）：`/member/order` 旧链接落到会员首页，服务端拒绝会员创建或取消水单（`MEMBER_READ_ONLY`）。
- 门店点单：员工端 `/staff/order` 与管理端「门店点单」弹窗共用 `CounterOrder`（查找或新建顾客 + `OrderMenu`）。顾客在店选「到店取水」时，提交即依次创建水单、收取需补押金、按「满桶领出 N / 换回空桶 M」交付；配送则生成待送水单。原「代开水单」表单已移除。
- 押金按 `calcDepositGap` 计算：需补个数 = max(0, 当前持有 + N − M − 押金覆盖)，押金覆盖 = 已交未退 − 待报废占用，与交付时服务端校验一致。下单时默认按「有多少空桶换多少」估算并提示；配送交付弹窗按实际换回数量计算，不足时可选收款方式先收押金再交付，交付时服务端仍会拦截押金不足。

## 5.3 列表分页与筛选

`GET /api/members`、`GET /api/orders` 与 `GET /api/ledgers/recharges|recharge-refunds|deposits|containers` 接受 `page`、`pageSize`（1–100，默认 20）。传入任一参数时返回 `{ rows, total, page, pageSize }`（与 `/api/containers/holdings|circulation|damages` 相同），`page`/`pageSize` 为服务端实际采用的值；都不传时仍返回旧的数组（会员、水单最新 50 条，流水最新 30 条），兼容会员选择器等调用方。筛选在服务端完成：会员 `q`（编号/姓名/手机号）、`status`、`water`（`BUCKET`/`BAG`：持有用这种容器装的任一水品的可用水票）；水单 `q`（单号、取水码、地址快照联系人/手机号/地址、会员姓名/手机号）、`status`、`mode`、`memberId`、`pickupCode`；充值、水费退款与押金流水 `q`（含会员编号与手机号）；水单与这三类流水另有 `from`（含）/`to`（不含）时间区间；充值与水费退款流水 `payMethod`；押金流水 `flowType`（`COLLECT` / `REFUND` / `DEDUCT`）与 `containerType`；容器流水 `containerType`。充值流水带出退清状态；押金流水带出会员编号和收付方式，退押金登记的退款方式存于 `deposit_refunds.pay_method`（此前登记的退款为空）。`q` 中的 `%`、`_` 按字面匹配。管理端会员管理、水单管理、水费充值、押金管理、桶袋台账的表格和员工端会员查询均按页加载；充值、押金、开单、领还和破损登记弹窗用 `@kunlun/ui` 的 `MemberPicker` 按姓名、手机号或会员编号向服务端检索会员，预选会员按 ID 读取档案，不依赖页面已加载的会员列表。`KunlunApi` 的 `membersPage`、`ordersPage` 及四个流水方法始终带 `page`。


## 6. 袋桶库存、周转与报废扣押

`ContainerInventory` 提供修改数量 `POST /api/containers/stock`：店里、客户手里、累计报废和提醒线 `warn_threshold` 都可直接填新值，未填的字段不动（避免改报废时冲掉同时发生的领还），以 `ADJUST` 记入库存操作并更新 `counted_at`。`RECEIVE` / `SCRAP`（`POST /api/containers/inventory`）对应库存页卡片上的「新购」「报废」快捷按钮：新购计入店里；报废从店里扣减并计入累计报废，不能超过店里现有数量；原因必填，页面未填时以“新购”“报废”提交。领还时店里与客户手里按同一数量反向变化，二者都是手记的数，各自最低记到 0、不拦截交付；只有会员名下汇总必须与会员余额一致。会员破损归还使会员名下和客户手里各减、待确认报废增加；确认报废使待确认报废减、累计报废增。店里少于提醒线时 `lowStockWarning` 为真，提醒线为 0 即不提醒。库存操作保留 before/after 快照。升级时客户手里 = 原会员名下 + 原盘点“未登记在外”，原“待核实”标记连同 `unregistered_out_qty` 一并删除，总量不变；更早的在途、待检、异常和门店破损数量在启动时并入店里后删除相应列。

`ContainerCirculation` 管理会员破损归还和确认报废。`container_damages` 保存原押金批次及金额、状态、两次操作的幂等回执。破损归还将 `deposit_lots.reserved_damage_qty` 增加；正常退款、领用覆盖额和可退押金展示都排除暂占数量。报废才减少批次 `remaining_qty`、增加 `deducted_qty` 并释放暂占，同时扣会员押金、更新库存并写 `container_ledgers`。财务流水以 `DEDUCT` 区别于 `REFUND`，对账包含累计扣押。

所有写入使用同一事务；锁序为幂等请求、会员、破损记录（适用时）、容器、押金批次。门店报废在容器锁下排除会员待报废数量。会员破损金额不足时拒绝整笔；不同幂等键也不能重复处理已报废记录。新迁移不追溯扣除既有旧库存流水中的押金。

路由 `/admin/inventory` 和 `/admin/assets` 独立呈现，主 HTML 与 `assets/inventory.js` 为唯一前端维护源，构建同步到两端。会员持有、周转流水、破损记录由服务器过滤和分页，避免仅展示最近记录造成台账遗漏。

## 6.1 审核申请：退款与手动赠送

`refund_requests` 记录所有退款和需审核的手动赠送：`kind`（`DEPOSIT` 押金退款 / `RECHARGE` 退清水费 / `GIFT` 店员充值时手动赠送）、会员、容器与数量或充值批次（`GIFT` 用 `quantity` 记赠送张数）、申请时估算金额、退款方式、原因、`status`（`PENDING` / `APPROVED` / `REJECTED`）、申请人与审核人、审核备注、实际退款单号与金额。部分唯一索引 `(batch_id, kind) WHERE status='PENDING'` 保证同一充值批次每类最多一笔待审核。旧库启动时放宽 `kind` 与形状约束（检测约束定义是否含 `GIFT`）。

`review_settings`（每租户一行）保存两个审核开关 `gift_review`、`refund_review`，默认都为真：

- `GET /api/settings/review`：员工可读，弹窗据此显示“申请”还是“当场办理”。
- `PUT /api/settings/review`：需 `staff:manage`，记录修改人和时间。

审核规则：有对应审核权限的账号（押金 `deposit:refund_approve`，水费与赠送 `recharge:refund`）自己办理时总是直接生效；其他账号在开关打开时提交申请、关闭时直接生效。直接生效的也写一条 `APPROVED` 申请，备注“管理员直接办理”或“无需审核，直接退款”。

- `POST /api/recharges` 增加 `giftQty`（0–1000，手动赠送）。需审核时付费票当场到账，赠送记为 `GIFT` 待审核申请，响应带 `pendingGiftQty`、`giftRequestNo`；否则赠送与付费票一起到账。`recharge_orders.manual_gift_qty` 记录店员填的赠送数，`gift_qty` 只记已到账的；同一幂等键改了赠送数返回 409。
- `POST /api/refund-requests`：提交退款（带幂等键）。押金需 `deposit:refund_apply` 或 `deposit:refund_approve`，申请数量不得超过 已交未退 − 持有 − 待报废 − 其他待审核数量；水费需 `recharge:create` 或 `recharge:refund`，批次须属于该会员且可退；原因选填。需审核时只写申请、不动账，否则在同一事务内退款并记为已通过，响应带 `status`、`refundNo`、`refundAmount`。
- `GET /api/refund-requests?status&kind&q&page&pageSize`：分页列表（需 `member:read`），带会员、容器或批次信息，赠送带原充值实收和付费张数（`rechargePaid`、`rechargeBuyQty`）。
- `POST /api/refund-requests/{id}/approve`：审核通过，押金需 `deposit:refund_approve`，水费和赠送需 `recharge:refund`。先锁会员、再锁申请，在同一事务内调用 `ExecuteDepositRefund` / `ExecuteRechargeRefund`（幂等键 `refund-request:{id}`），赠送调用 `GrantGift`（批次和充值单的赠送数、会员水票、`RECHARGE_GIFT` 流水），再写回审核结果；重复通过返回原结果，已驳回的返回 409。充值已退款的赠送不能再批准。
- `POST /api/refund-requests/{id}/reject`：驳回，原因必填，不动账；已通过的不能驳回。退清一笔充值时，其待审核的赠送自动驳回（“充值已退款，赠送作废”）。
- 原 `POST /api/deposits/refund`、`POST /api/ticket-batches/{id}/refund` 仅对有审核权限的账号开放，成功后由 `RefundRequests.RecordDirect` 补记一笔 `APPROVED` 申请（如该批次已有待审核申请则直接将其通过）。
- `GET /api/members/{id}/deposit-summary` 增加 `pendingRefundQty`，`GET /api/members/{id}/ticket-batches` 增加 `pendingRequestNo`（仅退款）和 `pendingGiftQty`。
- 流水接口：`/api/ledgers/recharges` 增加 `giftReview`（赠送审核状态、张数、审核人、备注），`/api/ledgers/recharge-refunds` 与 `/api/ledgers/deposits` 增加 `applicantName`，押金流水另带 `reason`（退款或报废原因）。

报废扣押可选免扣：`POST /api/containers/damages/{id}/scrap` 的 `deductDeposit=false` 时只释放押金批次的 `reserved_damage_qty`，不减少批次剩余、不扣会员押金；`container_damages.deposit_waived` 标记，周转流水业务类型为 `SCRAP_WAIVED`、扣押金额 0。财务汇总、押金流水和导出中的扣押统计排除免扣记录，剩余押金 = 累计收押 − 累计退押 − 累计报废扣押 仍成立。

## 7. 员工手机端功能与角色权限（2026-11-16）

功能目录有两份对照：`services/Kunlun.WaterStation/Auth/MobileFeatures.cs` 的 `Catalog`（功能 → 授予的权限码，服务端以它为准）与 `packages/shared/src/mobile.ts` 的 `MOBILE_FEATURES`（名称、图标、说明、所在页面）。`scripts/mobile-features.test.mjs` 比对两边的功能顺序与权限，防止漂移。

| 功能 | 授予权限（店员/送水员） |
| --- | --- |
| `order` 门店点单 | `member:read`、`order:create`、`order:fulfill`、`deposit:collect` |
| `orders` 水单履约 | `member:read`、`order:accept`、`order:fulfill`、`deposit:collect` |
| `pickup` 自提核销 | `pickup:verify`、`order:fulfill` |
| `members` 会员查询 | `member:read` |
| `newMember` 新建会员 | `member:read`、`member:write` |
| `recharge` 水费充值 | `member:read`、`recharge:create` |
| `depositCollect` 收押金 / `depositRefund` 退押金 | `member:read` + `deposit:collect` / `deposit:refund_apply` |
| `movement` 登记领还 | `member:read`、`container:register` |
| `inventory` 袋桶库存（高风险） | `container:inventory_manage` |
| `overview` 今日经营（高风险） | `report:export` |

- `role_mobile_configs(tenant_id, role, features JSONB, updated_by, updated_at)` 保存每个角色已开通的功能（有序，即工作台顺序）。首次启动按默认功能插入，并把店员、送水员的 `staff.permissions` 设为对应权限并集；之后重复启动不覆盖。
- `GET /api/mobile/roles`（需 `staff:manage`）：功能目录及各角色的功能、当前权限、默认功能、员工人数、上次保存人和时间。`PUT /api/mobile/roles/{role}` 保存 `{ features }`：只接受目录中的功能且不得重复；店员、送水员在同一事务里改写该角色全部员工的 `permissions`，管理员始终为全部权限；写 `auth_audit_logs`（`MOBILE_FEATURES`）。保存与新建员工（`POST /api/staff`，按角色当前功能取权限）共用一把事务级咨询锁。
- JWT 校验（`OnTokenValidated`）在核对状态和 `token_version` 的同一查询里读出员工当前 `permissions`，替换令牌中的 `perm` 声明，所以收回或授予功能在下一次请求即生效，无需重新登录或递增令牌版本。`GET /api/auth/me` 对员工另返回 `mobileFeatures`。
- 前端 `mobileLayout(features)` 是员工端与管理端预览共用的布局规则：前 `MOBILE_TAB_LIMIT`（3）个有独立页面的功能进入底部导航，其余非卡片功能为首页快捷入口。`@kunlun/ui` 的 `WorkbenchHome`、`WorkbenchTabBar`、`OrderCard` 与 `workbench.css`（由使用方显式引入，会员端不加载）同时用于员工端 `/staff` 和管理端 `/admin/mobile` 的手机框；袋桶库存的「新购 / 报废 / 修改数量」弹窗（`StockQuickDialog`、`StockEditDialog`）也移入 `@kunlun/ui`，管理端库存页与员工端 `/staff/inventory` 共用。员工端切换页面时重新读取 `me`，功能变化即时反映到导航和首页。

## 8. 会员档案整页与「可能要退的钱」（2026-11-16）

- 会员 360° 档案是 `Members` 页的一种状态：`/admin/members?id=<会员ID>`，不新增路由段（`resolveRoute` 只认两段路径，nginx、`scripts/vite-routes.ts` 与路由测试都不用改）。从列表打开时写入 `location.state.fromList`，返回时 `navigate(-1)`，直接打开的则替换为列表；列表滚动位置记在 `Members` 里。`pages/MemberProfile.tsx` 自己读取 `memberProfile`、`depositSummary`、`ticketBatches` 和最近记录（`ordersPage({ memberId })`，充值与押金流水按会员编号查询后再按编号核对），依赖 `useAdminData().version`，任何办理后的刷新都会重读。原抽屉及其样式已删除。
- `GET /api/members/{id}/ticket-batches` 新增 `remainingValue`：在用 `PURCHASE` 批次剩余付费票按原实付单价折算的金额（`MembershipEndpoints.RemainingValue`，舍入到分），历史余额和已退款批次为 0；`refundableAmount` 是没有水单占用时的 `remainingValue`；退清批次也用同一函数计价。
- `GET /api/reports/finance-summary` 新增 `unusedRechargeValue`（SQL 中按同一口径 `sum(round(paid_amount*remaining_buy/fixed_qty,2))`）、`unusedPaidTicketQty`、`unusedGiftTicketQty`、`legacyTicketQty`（历史余额张数，不计价）、`unrefundedDepositQty`、`potentialRefundTotal`（未退押金 + 没用完的水费）与 `rechargeEarnedTotal`（水费净收 − 没用完的水费）。集成测试 `Deposits_And_Unused_Paid_Tickets_Add_Up_To_Money_Members_Could_Ask_Back` 校验两笔充值、赠票、占用和押金带来的增量，以及退清后的回落。
- 点单：`useDepositPositions` 额外带出已交押金个数与金额、待报废和现在可退；`OrderMenu` 顶部按配套容器显示持有与押金小卡（管理端弹窗与员工端共用）。购物袋的「清空」只清已选数量和换回空桶的改动，不清除本次结算已生成的幂等键：上一次提交若其实已在服务端成功，再提交同一水品也不会重复下单。

## 9. 员工端安卓实测修正（2026-11-16）

- 细滚动条样式（`brand.css`）只在 `@media(hover:hover) and (pointer:fine)` 下生效。触屏 WebView 里自定义 `::-webkit-scrollbar` 会变成占位滚动条，`.h5-scroll` 一出现滚动就让出约 10px，内容整体变窄；手机、平板改用系统悬浮滚动条，桌面不变。
- 提示条分成功与失败：`useToast()(message, 'error')` 显示警示图标（新增 `alert` 图标，红色），否则仍是对勾。`useRun` 捕获的异常、各端页面级刷新失败和退出失败都走 `'error'`，不再出现“对勾 + 请求失败”。
- H5 入口声明图标 `src/favicon.svg`，由 Vite 打包为 `/static/h5/favicon-<hash>.svg`。员工端安卓容器只放行员工页面、`/static/h5/` 资源和接口，未声明图标时 WebView 会请求 `/favicon.ico` 并被拦成 403；生产页面检查要求引用都在 `/static/h5/` 下，所以不用内联 data URI。

## 10. 业务单号按北京时间取日期（2026-11-17）

- 水单 `ORD-yyyyMMdd-NNNNNN`、押金 `YJyyyyMMddNNNN`、押金退款 `TKyyyyMMddNNNN`、审核申请 `SQyyyyMMddNNNN` 中的日期取水站时区 Asia/Shanghai 的当天，与首页统计 `now() AT TIME ZONE 'Asia/Shanghai'` 同一口径。`BusinessNumbers.Day` 按固定 UTC+8 计算（上海自 1991 年起不用夏令时），不依赖运行镜像里的 tzdata。此前取 UTC 日期，北京时间 0–8 点生成的单号带前一天的日期（如 11-17 03:50 的水单是 `ORD-20261116-000001`），历史单号不改。
- 序号来自 `business_number_counters`，键为 `(scope, period)`，period 就是这个日期串。新旧规则的日期串格式相同，同一日期只有一行计数，切换前后开出的号都在这一行上接着编；新出现的日期从 1 开始，`Next()` 用 EXISTS 跳过业务表里已被占用的号码，所以切换当天不会重号。会员编号 `No.NNNNNN` 不带日期，按租户计数，不受影响。
- 日期取自 `BusinessNumbers.Clock`（默认 `TimeProvider.System`，仅测试替换）。`BusinessNumberTests` 覆盖北京零点、03:50（UTC 仍是前一天）和跨年，并在停住的时钟下经接口开出四类单号，验证 08:00 后沿用同一计数、计数行重建后跳过已占用号码。

## 11. iOS 员工端（2026-11-17）

- `apps/ios-staff` 按 Android 员工端的方式实现：构建阶段把 `apps/mobile-h5` 打包进 App 的 `www/`，WKWebView 加载 `kunlun-staff://localhost/staff`。页面看到的是同源 `/api/…`，由 `WKURLSchemeHandler` 转发到 `STAFF_ORIGIN`（Debug 默认 `http://127.0.0.1:5188`，Release 只接受 HTTPS），所以前端不需要改，后端也不需要为 App 放开 CORS。允许的页面列表 `StaffRoutes.pages` 与 Android 的 `StaffUrls.PAGES` 都由 `scripts/web-routes.test.mjs` 对照 `WEB_ROUTES.staff` 检查。
- 自定义协议的主机名用 `localhost`，这样页面才是安全上下文；否则 `crypto.randomUUID()` 不存在，点单和办理业务生成幂等键时会报错。
- 转发不带 Cookie、`Origin`、`Referer`，不跟随重定向，响应去掉 `Set-Cookie` 和压缩头（URLSession 已解压）。WebKit 可能随时停止某个请求，被停止后不能再回写，否则会抛异常，所以转发中的请求按任务登记，停止时取消。
- 实测：iPhone 17 Pro Max 模拟器（iOS 26.5）连本机临时后端（演示数据），店员账号完成登录、点单（配送、水票、备注）、接单、确认交付扣票、会员搜索与办理、水费充值、新建会员、我的、左缘返回；断开后端时页面提示「网络连接失败」。最初让 SwiftUI 随键盘缩小 WebView，底部导航会被顶到输入框上方，已改为键盘覆盖页面，与 Safari 一致。
- 送水员实测（同一环境）：首页只有自提核销、收押金、登记领还，底部没有点单；接单后收押金并交付；少送时不填原因被拦下（400 提示 AC-14），填写后交付；取水码格式不对时由表单拦下，码不对时服务端提示「6 位自提核销码不匹配」，码正确则核销成功；登记还回空桶；会员页没有充值和点单；退出登录。用送水员令牌直接调接口，下单、充值、新建会员、改地址都返回 403。
- 管理员实测（同一环境）：首页「今日经营」卡片（今日充值、今日用水、待配送、待自提和近 7 天走势）；袋桶库存新购 10 个、报废 1 个、点数字直接改库存；退押金在没有可退桶袋时由表单拦下，登记还回 1 个桶后退 ¥50，管理员办理立即生效、不进审核；编辑收货地址成功，门牌号提示随之消失（地址按钮的问题只出在送水员）；水费充值 ¥100 / 16 桶后「退清剩余水票」¥100，批次标为已退款、剩余 0。「今日充值」是当天充值单的实付合计，不扣当天退款，所以全额退掉后仍显示 ¥100。
- 顺带发现：
  - 水单、押金、退款等日编号当时按 UTC 取日期，北京时间 0–8 点生成的单号带前一天的日期；已改为按北京时间，见「业务单号按北京时间取日期」一节。
  - 送水员没有 `member:write`，会员页的收货地址却显示新增、编辑、删除，填完保存才提示「当前账号没有此操作权限」，缺门牌号的提示也让送水员去编辑；已改为按 `member:write` 显示写操作，见「5.1 会员收货地址簿」。
  - Android 员工端当时会拦下 `tel:` 链接，iOS 端则交给系统电话；Android 现在也打开拨号盘，见「Android 员工端按角色实测」一节。

## 12. Android 会员端（2026-11-17）

- `apps/android-member`（`cn.idalee.kunlun.member`）照 Android 员工端的做法实现：构建时把 `apps/mobile-h5` 打包进 APK，WebView 打开 `MEMBER_ORIGIN/member`，会员页面和 `/static/h5/` 资源由 `WebViewAssetLoader` 从包内返回，同源 `/api/` 照常发往服务器，其他地址返回 403，跳转被拦下。Debug 连 `http://127.0.0.1:5188`（只对 127.0.0.1 放行 HTTP），Release 只接受 HTTPS，默认正式服务。允许的页面 `MemberUrls.PAGES` 含会员各页和两个旧链接，由 `scripts/web-routes.test.mjs` 对照 `WEB_ROUTES.member` 检查；CI 的 android 任务同时构建、测试会员端 debug 和 release 包。
- 和员工端一样不设 `VITE_NATIVE_APP`，登录页没有「切换到员工登录」。登录状态在 WebView 的 sessionStorage 里，App 被关掉后需要重新登录。Android 13 起最近任务的缩略图不显示会员信息（直接从 App 进入多任务时系统显示实时画面），不禁止截图。
- 实测：Android 17 模拟器（Medium Phone）连本机临时后端（演示数据），会员陈静（`no.008621`）。密码错误时登录页提示「用户名或密码错误，或账号已停用」；店员在后端办理充值、送水下单并交付、送水和自提各留一单待办、收水袋押金后，会员端首页水票余额和预占、用水记录（配送地址、备注、状态）、押金与桶（合计 ¥135）、充值记录（含历史余额批次）都对得上；返回键先回应用内上一页；后端停掉时提示「网络连接失败，请检查网络后重试」，后端恢复后自动刷新；退出登录后旧令牌在服务器端返回 401；改密码时输错原密码只在对话框里提示，改成功后回到登录页，旧密码登录被拒、新密码可以登录；在 App 里请求或跳转 `/staff`、`/admin` 都被拦下。
- 修正（会员 H5，网页会员中心同样生效）：
  - 待自提的水单不显示取水码。会员到店要出示 6 位取水码，后端也返回给本人，但订单卡片没有渲染；iOS 会员端是显示的。现在会员的待自提水单在卡片底部显示取水码，员工端列表不变。
  - 窄屏手机上水票卡片的「配送票 / 预占 1」被挤成「配送 / 票」两行。现在预占数放不下时单独换行。
- 实测时去掉 adb 端口映射并不能模拟断网：WebView 会继续复用已建立的连接，所以改为直接停掉后端。

## 13. Android 员工端按角色实测（2026-11-17）

- 容器补上 iOS 员工端已有的行为：
  - 点电话号码（水单上的收货人电话）打开系统拨号盘并填好号码，由员工自己拨出，不需要电话权限。只认手指点击触发的 `tel:` 链接，号码只能由数字、空格、括号、连字符和开头的 `+` 组成（`StaffUrls.phoneNumber`）；脚本跳转、`*21#` 这类代码都被拦下。会员页面不显示收货人电话，会员端不处理。
  - Android 13 起最近任务的缩略图不显示业务内容，与会员端一致。
  - 页面渲染进程被系统回收或崩溃时（`onRenderProcessGone`）换一个新的 WebView，App 不再整个退出。崩溃后停在「页面加载失败，请重试」，点「重新加载」才重开，避免反复崩溃；被回收则直接重开。登录状态随旧 WebView 丢失，需要重新登录。会员端同样处理，重试页的文字和按钮也改为居中。
- 实测：Android 17 模拟器（Medium Phone）连本机临时后端（演示数据）。
  - 店员（`yg0012`）：点单选送水上门、预约时段、填备注，接单后确认交付扣票；点收货人电话打开拨号盘；按会员编号搜索，水费充值、收押金；用 DevTools 让渲染进程崩溃后出现重试页，重新加载回到登录页；回到桌面后最近任务缩略图是空白。
  - 送水员（`yg0008`）：首页只有自提核销、收押金、登记领还，底部没有点单；接单后少送 1 桶，不填原因被拦下（AC-14），填写后交付，只扣 1 张、另 1 张预占释放；取水码不对时提示「未找到待核销的订单或自提码无效」，码正确则核销；会员详情没有充值，收货地址只读；登记还回空桶；退出登录后旧令牌返回 401。
  - 管理员（`yg0001`）：「今日经营」卡片的今日充值 ¥200、今日用水 4 与当天单据一致；袋桶库存新购 5 个、报废 2 个；退清一笔充值批次 ¥100，批次标为已退款。
- 修正（员工 H5；网页员工端和 iOS 员工端打包的是同一份，同样生效）：
  - 点单结算页滚到底时，底部的合计条盖住最后一张卡片，备注输入框点不到。`.h5-scroll` 已为底部导航留出 76px 内边距，`workbench.css` 又给合计条加了 `bottom:74px`；WebKit 和 Chromium 都从滚动容器的内边距以内计算 sticky 的 `bottom`，两者叠加把合计条抬高了一截。去掉这条覆盖后，合计条贴在底部导航上方，备注框完整露出。
  - 会员详情（「会员办理」）里办完充值、收押金、登记领还或退款，详情仍显示打开时的水票、押金和持有数，关掉重开才更新。现在详情跟随刷新后的会员列表显示。

## 14. iOS 会员端连本机后端实测（2026-11-17）

- 会员端原来只能连正式环境和独立测试环境（都是 HTTPS），模拟器里没法连本机后端联调。Debug 版新增启动参数 `-MemberOrigin http://127.0.0.1:<端口>`，只接受本机回环地址（`127.0.0.1` 和 `localhost` 在模拟器上都实测可连，ATS 不拦截），Release 不读取。连本机时令牌存在单独的钥匙串项 `cn.idalee.kunlun.member.local`，不影响正式和测试环境已保存的登录；登录页右上角、各业务页顶部和「我的」页的当前服务都标出本机后端地址，不能切换环境。从 Debug 的「体验演示」点「返回真实登录」也回到这个本机后端，不会落到正式环境（实测登录请求落在本机端口）。演示时「我的」页的当前服务改为显示「演示数据」，原来显示「测试环境」。
- 实测：iPhone 17 Pro Max 模拟器连本机临时后端（演示数据），会员陈静（`no.008621`）。密码错误时登录页提示「用户名或密码错误，或账号已停用」；店员在后端办理充值、送水下单并交付、自提下单并核销、收押金后，会员端下拉刷新即可看到水票余额和预留、用水记录（配送地址、备注、取水码）、状态筛选、充值记录（含历史余额批次）、押金与桶；收货地址只读；深链接 `kunlun-member://records` 打开记录页；退出登录后服务器令牌失效；改密码后旧密码登录被拒、新密码可以登录；后端停掉时页面提示「暂时无法加载 / 无法连接服务器」，退出时可选「仅清除本机登录」。用会员令牌直接调接口，只能读本人数据：读别的会员、会员列表、下单、充值、收押金、经营报表都返回 403。
- 修正：
  - 用水记录下拉刷新后一直转圈。刷新时列表先换成加载中，SwiftUI 取消这次请求（后端记为 499）后列表变为空闲，之后没有任何东西再去加载。现在同一筛选条件下刷新会保留现有记录直到新结果返回，被取消也不清空；换筛选条件仍先显示加载中。
  - 修改密码时输错当前密码会被直接退出。后端对当前密码错误也返回 401，App 当成登录失效清掉了会话，登录页只剩一句「用户名或密码错误」。现在与网页端一致，错误留在修改密码页，会话保留；真失效的令牌会在下一次读数据时退出。
  - 充值记录里的历史余额批次显示「· 送水上门」（没有快照，水品名为空）和占位日期「2000年1月1日」。现在按会员水票里的水品名显示，不显示日期。
  - 离线退出提示里的「无法连接服务器。。」多了一个句号。
- 顺带发现（未改）：后端对「当前密码错误」返回 401，和登录失效同一个状态码，客户端只能按请求路径区分（网页端对 `/api/auth/` 下的 401 不触发退出）。

## 15. Android 正式签名与数字输入框（2026-11-17）

- Android 员工端、会员端的正式包可以签名了。
  - `-PkunlunSigning=<文件>`（或环境变量 `KUNLUN_ANDROID_SIGNING`）指向仓库外的签名配置，含 `storeFile`、`storePassword`、`keyAlias`、`keyPassword`。
  - 同时打 v1、v2 签名；文件不存在或缺项时构建直接失败。不提供时与以前一样打出未签名的包，CI 不受影响。
  - 两个 App 的版本定为 `versionCode` 1 / `versionName` 1.0.0。
  - 生成密钥和打包的步骤见 Android 员工端 README「正式签名与打包」。
- 数字输入框删掉原数字再输入，会显示成「01」。
  - 原因：受控的 `type="number"` 输入框直接绑定数字时，清空后 React 填回「0」；再输入 1，文字「01」和数值 1 相等，React 就不再改写。
  - 新增共用的 `NumberInput`：显示用户输入的文字，清空时代表 0，离开输入框后再显示数值。
  - 改用它的地方：点单数量和赠送等步进器（`Stepper`，库存三个数也用它）、交付数量与桶数、库存提醒线。管理端的金额和数量输入框本来就按文字保存，不受影响。

## 16. Android 自动更新（2026-11-17）

- 员工端、会员端在蒲公英分发。蒲公英的检查更新接口要用账号 API Key，这个 Key 还能上传、删除应用，接口返回的下载地址里也带着它，所以不能打进 APK。改为后端代查：
  - `GET /api/app-update/android/{staff|member}?versionCode=N`，不用登录。后端用 `Kunlun:Pgyer:ApiKey`（compose 里取 `.env` 的 `KUNLUN_PGYER_API_KEY`）和该 App 的 App Key 调蒲公英 `apiv2/app/check`，只回 `hasUpdate`、`versionName`、`versionCode`、`notes`、`force`、`url`。
  - 蒲公英说有新版、且新版的 `versionCode`（`buildVersionNo`）大于已装版本时才算有更新，刚装好的版本不会再提示。`url` 取 `appURl`；它不是 HTTPS 的 `www.pgyer.com`、`pgyer.com` 页面时改用短链接 `buildShortcutUrl`，并去掉查询参数。带 Key 的 `downloadURL` 不转给 App，日志只记蒲公英的 code 和 message。
  - 答复按（App，已装版本）缓存 10 分钟，失败只缓存 1 分钟；接口另有每分钟 60 次的限流（`app-update`）。没配 Key、蒲公英出错或答复不完整时一律回「没有更新」。
  - 两个 App Key 不是机密，写在代码里，可用 `Kunlun:Pgyer:StaffAppKey`、`Kunlun:Pgyer:MemberAppKey` 覆盖；`Kunlun:Pgyer:BaseUrl` 只在本机联调时指向模拟服务。
  - 后端容器原来只在内部网络，不能出网。两套 compose 给 API 加了只用于出网的 `egress` 网络，数据库仍只在内部网络。这个网络上只有 API 自己，Docker 默认隔离不同的网络，从这里能连到 API 的只有宿主机。
- App（`AppUpdate` 负责解析和判断，`UpdateChecker` 负责联网和弹窗，两个 App 各一份）：
  - 启动时检查一次，之后回到前台时最多每小时一次；没联网或后端出错时 5 分钟后再试。
  - 有新版时弹窗「发现新版本 x.y.z」，显示更新说明和当前版本。「立即更新」用系统浏览器打开蒲公英安装页，只打开 HTTPS 的 `www.pgyer.com`、`pgyer.com` 页面。「以后再说」或返回键：这个版本 24 小时内不再提示，更新的版本照常提示。强制更新没有「以后再说」、关不掉，回到 App 就再弹出，不受之前「以后再说」影响。
  - 版本改为 `versionCode` 2 / `versionName` 1.1.0。1.0.0 没有检查更新，已装 1.0.0 的手机要手动装一次 1.1.0。
- 实测：
  - 后端新增 3 个测试（没配 Key；有新版、缓存和各种安装页地址；蒲公英各种失败），全部 83 个通过。Android 两端新增解析和「以后再说」规则的单元测试，构建和 lint 通过。
  - Android 17 模拟器连本机后端，后端的 `Kunlun:Pgyer:BaseUrl` 指向本机模拟的蒲公英。
    - 员工端弹出 1.2.0 的更新，后端查蒲公英时带的是员工端 App Key 和 `buildVersion=2`。点「以后再说」后重启 App 不再提示。
    - 改成强制更新后，弹窗没有「以后再说」，返回键关不掉。点「立即更新」打开 Chrome 访问 `https://www.pgyer.com/…`，回到 App 再次弹出。
    - 已是最新版、后端停掉时都不弹窗，App 照常使用。
    - 会员端用会员端 App Key 查询，弹窗相同，返回键等同「以后再说」。
  - 从 al 上桥接网络的容器访问蒲公英接口正常（不带 Key 时返回 `{"code":1001,...}`）。服务器配好 Key 后在 al 上直接查蒲公英：同一个 API Key 两个 App 都能查；两个 App 当时都是 1.0.0（`buildVersionNo` 1），传 `buildVersion=1` 答没有新版，传 0 答有新版；`appURl` 和短链接 `buildShortcutUrl` 都是完整的 `https://www.pgyer.com/…` 地址，打开是对应 App 的下载页。
- 没做：App 内下载安装（要 `REQUEST_INSTALL_PACKAGES` 和 FileProvider，蒲公英的直接下载地址又带着 Key），改由浏览器打开安装页。
- 顺带发现（本次未改）：两个限流都按 `RemoteIpAddress` 分组，但请求都经 nginx 转来，后端看到的是同一个地址，所以登录的「每分钟 15 次」实际是所有人共用。改为按真实客户端 IP 计数见 PR #46（第 17 节）。

## 17. 限流按真实客户端 IP 计数（2026-11-17）

- 问题：线上和测试环境的请求都是 Caddy（`atlas-wiki-gateway-1`）→ nginx（`kunlun-web` / `kunlun-test-web`）→ `api:8080`。后端不处理转发头，看到的来源总是 nginx 在 `backend` 网络里的地址，所有人共用登录的每分钟 15 次。会员端 1.0.0 每次打开都要重新登录，人一多就会被 429 挡住。
- 转发头链路（在 al 上核实）：
  - Caddy v2.11.4 的 `reverse_proxy` 没有配 `trusted_proxies`，会丢掉客户端自己带的 `X-Forwarded-For`，改写成它看到的客户端地址。带伪造的 `X-Forwarded-For` 请求测试站，nginx 日志里只剩真实地址。
  - nginx 默认原样转发请求头，Caddy 写的值本来就会到后端。`deploy/nginx.conf` 的 `location /api/` 现在显式写出 `proxy_set_header X-Forwarded-For $http_x_forwarded_for`，行为不变，只是把约定写进配置。不能改成 `$proxy_add_x_forwarded_for`：那样最后一项会变成 Caddy 的地址，大家又挤在一起。
- 后端：`UseForwardedHeaders` 放在中间件最前面，只处理 `X-Forwarded-For`，`ForwardLimit = 1`，只信任来自私有网段（`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`fc00::/7`）和本机回环的对端。API 不发布端口：在 `internal: true` 的 `backend` 网络上能连到它的只有 nginx（和数据库），第 16 节加的 `egress` 网络上只有宿主机能连到它，所以这就是只信任 nginx 这一跳。
  - 只取最后一项。客户端在前面塞的地址不起作用。
  - 对端不在这些网段时，不管带什么头，都按对端自己的地址计数。
  - 登录和 App 更新检查（`app-update`，第 16 节）两个限流策略仍按 `Connection.RemoteIpAddress` 分组，代码不用改，现在都按真实客户端计数。
- 前提：nginx 只能经 Caddy 访问（宿主机诊断口只绑 `127.0.0.1`）。如果把 nginx 直接暴露到公网，客户端就能自己写 `X-Forwarded-For`。
- 测试：`ClientAddressRateLimitTests` 用生产环境的限额，手动设定 TestServer 请求的对端地址。
  - nginx 后面的两个客户端各有 15 次。
  - 在 Caddy 写入的地址前面塞别的地址，不会多出次数。
  - 公网对端带任意 `X-Forwarded-For`，都按它自己的地址计数。
  - TestServer 请求默认没有对端地址，这时中间件会无条件采用转发头，所以测试必须显式设置对端。

## 18. 补录会员上系统前的数据（2026-11-17）

- 问题：很多会员在水站用这套系统之前就买了套餐、交了押金、拿着桶，系统里查不到。新增权限 `member:opening`（`KunlunPermissions.MemberOpening`，`metadata/permissions.json` 标为高风险），默认只给管理员：`AdminAll` 包含它，`MemberOpening.EnsureSchema` 启动时给已有的管理员账号补上。权限每次请求从数据库重新读，已登录的管理员不用重新登录。它不属于任何手机端功能，「移动端配置」开通不了，店员、送水员都没有。
- 接口（`Operations/MemberOpening.cs`）：
  - `GET /api/members/{id}/opening`（`member:read`）：这位会员上系统前的押金批次（个数、单价、金额、押金单号、未退个数；`locked` 表示已退过或报废扣过，不能再改）和最近 50 张补录单。
  - `POST /api/members/{id}/opening`（`member:opening`）：一次提交 `tickets`（套餐余量）、`deposits`（押金）、`holdings`（手里的桶袋）和备注（200 字以内），带幂等键。先锁请求键、再锁会员行，在同一事务内依次处理套餐、押金、桶袋，写一张补录单 `QC{yyyyMMdd}{NNNN}`（`member_opening_entries`，回执里有每一处的改前、改后）。重放返回原回执，同一个键换了内容返回 409；填的和现在记的一样返回 400，不写单；任何一处出错，整张都不生效。
- 套餐余量：每条新建一个 `source='OPENING'` 的 `ticket_batches`，水票加进 `member_tickets`，流水记 `OPENING`。
  - 知道套餐：填当时实付和套餐张数（选现有套餐时带出，可改），照填 `paid_amount`、`fixed_qty`。剩余票按原实付单价折算没用完的水费，能按原价退清（`RemainingValue.Priced`：`PURCHASE`，或 `OPENING` 且实付大于 0）。
  - 套餐不清楚：实付记 0。和历史余额一样只计张数、不计价，不能按原价退（退款返回 400）。
  - 名称、水品和补录单号写进 `opening_snapshot`。批次列表、退款审核和退水费流水的套餐名先取充值快照，没有再取这里。会员也能读批次列表，所以返回时去掉快照里的备注和经办人，这两项只在补录单上。
  - `created_at` 记为会员建档时间。分配和退款原来就按 `created_at, id` 排序，查询不用改，就会先用、先退上系统前的余额。
  - 修改：只能改补录的批次，系统里充值的返回 400。还剩数量不能少于未完成水单占着的数（409），有价套餐不能多于套餐张数（400），流水记 `OPENING_ADJUST`。没下过单、没办过退款的可以删除，流水记 `OPENING_REMOVE`。已退款或有退款申请在审核的不能改（409）。
- 押金：每位会员每种桶袋最多一笔上系统前的押金（`deposit_lots.source='OPENING'`，部分唯一索引）。`pay_method` 记 `OPENING`，`created_at` 记建档时间，退押金时按 FIFO 先退它；`members.deposit_amount` 同步加减。没退过、没报废扣过、没有待报废占用、也没有待审核的退押金时，可以改个数和单价，改成 0 就是删除；否则返回 409。
- 手里的桶袋：把会员名下的个数直接改成填的数，并写一条 `container_ledgers`：`business_type='OPENING'`，满桶出、空桶回都是 0，单号是补录单号，备注取补录备注。
  - 桶早就在会员手里，所以店里不动。
  - 客户手里取原数和会员名下合计中较大的那个，已经数进客户手里的不会重复加。
  - 改少时客户手里不自动减，需要时在袋桶库存直接改。
- 报表口径（`ReportEndpoints.cs`）：
  - 上系统前的押金在池里、能退，但不是这段时间收的钱。`depositCollectedTotal` 不含它，另列 `depositOpeningTotal`、`depositOpeningCount`；零误差对账改为 上系统前 + 收押 − 退押 − 扣押 = 在池。押金明细和导出里，这类流水记为 `OPENING`。
  - 补录的套餐不写 `recharge_orders`，水费实收和趋势都不变。
  - 有价的余量另列 `openingUnusedValue`、`openingPaidTicketQty`，计入 `potentialRefundTotal`。
  - 退这部分的钱另列 `openingRefundedTotal`、`openingRefundCount`。`rechargeEarnedTotal` = 水费净收 −（退款 − 其中退上系统前的）− 没用完的水费，所以退上系统前的余额不会冲减系统里的收入。
  - 套餐不清楚的计入 `legacyTicketQty`。
- 管理端（`apps/admin-pc/src/opening.tsx`）：
  - 会员整页档案页头「补录历史数据」（需 `member:opening`）打开「补录上系统前的数据」弹窗。套餐余量、押金和手里的桶袋一次填好；已经补录过的会带出来，只提交改了的部分。
  - 档案新增「上系统前的数据」卡片，列出历次补录。
  - 押金管理新增「上系统前」页签。押金管理、袋桶台账和会员最近记录都用「上系统前」标签。
  - 经营总览「可能要退给会员的钱」注明其中上系统前买的部分。
  - 共用的充值批次卡片（管理端、H5 会员端；Android 会员端用的也是 H5 页面）写明「上系统前买的」和当时实付。套餐不清楚的批次没有退款按钮。
- 测试：新增 `MemberOpeningTests`（5 个）：
  - 补录不算当天收入；
  - 只有有权限的账号能补录，重放、并发和失败都不会重复入账；
  - 先用先退，按原价退；
  - 下单或退款之前都能改；
  - 已有管理员启动后自动获得权限。

  `MembershipTests` 的两个恒等式加上了上系统前的部分。全部 89 个测试通过。
- iOS 会员端（原生页面，`apps/ios-member`）：充值记录里补录的批次写明「上系统前买的 · 补录单 QC…」，不显示日期（那是会员建档时间）；有价的金额旁注明「当时实付」；套餐不清楚的显示「套餐不清楚」而不是 ¥0.00，不显示购票数，脚注提示可以照常用水、不能按原价退。`opening` 字段可选，旧后端照常解码。见 PR #49。

## 19. iOS 上传 TestFlight（2026-11-17）

- 开发者账号是个人类型（Individual），App Store 上显示个人姓名。会员端、员工端都以 1.0.0（构建号 1）上传到 App Store Connect，处理完成后出现在 TestFlight。员工端版本从 0.1.0 改为 1.0.0。
- 新团队里没有登记设备，按自动签名直接归档会失败：生成开发描述文件至少要一台设备。上传 App Store 用不到开发描述文件，所以改为先不签名归档（`CODE_SIGNING_ALLOWED=NO`），导出时按 `app-store-connect` 自动签名。Xcode 通过登录的账号注册了两个 Bundle ID，生成了 Apple Distribution 证书和 App Store 描述文件。导出的包核对过：签名是 Apple Distribution，描述文件不绑定设备，`get-task-allow` 为 false。
- `scripts/ios-release.sh member|staff [upload|export]` 固化了这套流程。团队 ID 由环境变量 `KUNLUN_IOS_TEAM` 传入，不写进仓库；归档保留在 `~/kunlun-release/ios/<版本>-<构建号>/`。
- 两个 App 都已有隐私清单和 1024 图标，并声明不使用受管制加密（`ITSAppUsesNonExemptEncryption` 为 false），上传时没有警告。
- 还没做：会员端上架 App Store 需要隐私政策网址、「App 隐私」问卷、iPhone 和 iPad 截图和审核用会员账号；员工端走 TestFlight 内部测试，要把员工加进 App Store Connect 团队。

## 20. Windows 管理端（2026-11-17）

- 门店电脑是 Windows 10 以上，整天开着管理端，所以 `apps/windows-admin`（`cn.idalee.kunlun.admin`）把它做成可安装的 App。它是一个 Electron 窗口，直接打开线上 `https://kunlun.idalee.cn/admin`，不像员工端、会员端 App 那样把页面打包进去：线上发布后各台电脑打开就是新版，也就没有「先更新线上服务、再发 App」的顺序问题。代价是必须联网，这和浏览器一样，业务数据本来就在服务器上。
- 窗口里只开这台服务器的 `/admin` 页面（`/` 会跳转过去，所以也放行），其他 `https://` 链接交给系统浏览器，其余的丢掉；`window.open` 打开管理端页面时就在本窗口加载。规则在 `src/rules.js`，`scripts/web-routes.test.mjs` 对照 `WEB_ROUTES` 检查：管理端每个页面和旧链接都能打开，员工端、会员端页面都打不开。页面运行在沙箱里，没有 Node 能力；除写剪贴板和全屏外，其他浏览器权限一律拒绝。
- 连不上服务器或主页面返回 5xx 时（发布切换时会有几秒 502），换成包内的重试页，每 10 秒自动重连，证书错误单独提示。导出等 blob 下载弹「另存为」，默认存到「下载」文件夹。
- 服务器地址在打包时写进包内的 `package.json`，只接受 HTTPS；`KUNLUN_DESKTOP_ORIGIN` 只在从源码运行时有效，此时可以用本机 `http://127.0.0.1`。连别的服务器打出的包名字带「（测试）」、App ID 加 `.test`，能和正式版装在同一台电脑上。
- 安装包是当前用户一键安装的 NSIS（x64，不需要管理员权限），约 113 MB；macOS 上也能打包。还没有代码签名，首次运行会出现 SmartScreen 提示。CI 新增 `windows` 任务，测试网址规则、打包并上传 `windows-admin-installer`。
- 本机验证：在 macOS 上从源码运行，连临时搭的本机服务，登录、切换页面、刷新后保持登录、拦截员工端/会员端/外部/本地文件地址、导出触发下载、快捷键缩放并在重启后保留、断网和 502 的重试页及恢复后自动回到管理端都实测过。安装包的 exe 图标、版本信息和包内服务器地址也核对过。还没在真的 Windows 电脑上安装运行。

## 独立测试服务（2026-10-30，2026-11-01 更新）

`kunlun-test.idalee.cn` 使用独立 Compose、数据库 `kunlun_test`、非超级用户 `kunlun_test_app` 及 JWT 密钥，承载管理端与 H5 的联调。`/healthz` 返回当前数据库名，部署检查据此确认连接的是测试库。详见 [测试部署](../deploy/test/README.md)。
