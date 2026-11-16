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
    └── mobile-h5/                        # @kunlun/mobile-h5：员工端 /staff 与会员端 /member H5（React 18 + Vite）
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

## 独立测试服务（2026-10-30，2026-11-01 更新）

`kunlun-test.idalee.cn` 使用独立 Compose、数据库 `kunlun_test`、非超级用户 `kunlun_test_app` 及 JWT 密钥，承载管理端与 H5 的联调。`/healthz` 返回当前数据库名，部署检查据此确认连接的是测试库。详见 [测试部署](../deploy/test/README.md)。
