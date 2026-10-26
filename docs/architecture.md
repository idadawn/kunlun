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
├── index.html / admin.html / staff.html / member.html / assets/
│                                        # 三端独立交互原型（管理端 PC + 员工端小程序 + 会员端小程序）
├── services/
│   ├── Kunlun.WaterStation/             # .NET 10 核心业务插件与宿主 (id: kunlun.waterstation)
│   └── Kunlun.WaterStation.Tests/       # 集成与验收测试 (AC-01 ~ AC-20)
├── packages/
│   └── shared/                          # @kunlun/shared：三端共享类型、四账计算公式与权限常量
└── apps/
    ├── admin-pc/                        # @kunlun/admin-pc：管理端 PC (React + Vite + @idadawn/yue)
    └── mini-app/                        # @kunlun/mini-app：员工端 & 会员端微信小程序 (Taro 4 + React)
```

---

## 2. 认证与权限体系（Auth & RBAC）

### 2.1 三端登录方式

三端统一使用用户名和密码。管理端仅接受 ADMIN，员工端接受 STAFF，会员端接受 MEMBER。用户名不区分大小写，支持 3–32 位字母、数字、点、横线和下划线；密码 8–128 位，以随机盐 PBKDF2-SHA256（600,000 次）保存，兼容升级前员工密码摘要。不存在手机号免密登录入口。

首次部署显式提供数据库连接、至少 32 字节 JWT 签名密钥及初始化管理员用户名/密码；只在员工表为空时创建管理员。默认不写演示账号。已有员工使用原工号作为用户名，会员由授权员工在会员详情中设置账号。修改密码、重置凭证、退出登录和停用账号均递增 token_version，服务端每次请求检查状态和版本。登录按来源 IP 限流，页面不保存密码。

开发启动必须显式提供环境配置，不自动读取 `.env.local`。测试仅使用 `KUNLUN_TEST_DATABASE_URL`，自行创建独立测试数据库并在结束后删除。三端 HTML 与 assets 由根目录维护，通过 `pnpm sync:frontends` 同步到 Vite 入口和 public，避免页面副本漂移。

### 2.2 四级内置角色与权限码（`kunlun.waterstation:<resource>:<action>`）

| 角色标识 | 角色名称 | 默认权限范围 |
| --- | --- | --- |
| `MEMBER` | 水站会员 | 无后台权限码；服务端强制按当前令牌中的 `member_id` 执行数据隔离 |
| `COURIER` | 送水员 | `member:read`、`order:accept`、`order:fulfill`、`deposit:collect` |
| `CLERK` | 驻店店员 | 含送水员全部权限 + `member:write`、`recharge:create`、`order:create`、`pickup:verify`、`container:register`、`deposit:refund_apply` |
| `ADMIN` | 站长/管理员 | `kunlun.waterstation:*`（含 `deposit:refund_approve`、`order:correct`、`plan:manage`、`report:export`、`staff:manage`） |

---

## 3. 四账分离数据库设计（PostgreSQL 16 + RLS）

数据库 Schema 统一为 `plugin_kunlun_waterstation`，所有业务表均含 `tenant_id UUID NOT NULL` 并开启 PostgreSQL 行级安全策略（RLS），天然支持从“绿麒麟单水站”平滑扩展至“多水站独立核算”。

### 3.1 10 张核心表清单

1. **`staff`（员工表）**：`id`, `tenant_id`, `staff_no`, `name`, `phone`, `role`, `permissions`, `status`, `token_version`, `wx_openid`
2. **`members`（会员表）**：`id`, `tenant_id`, `member_no`, `name`, `phone`, `wx_openid`, `default_address`, `status`, `source`
3. **`recharge_plans`（优惠方案表）**：`id`, `tenant_id`, `name`, `water_type`(`BUCKET_18_9L`/`BAG_7_5L`), `fulfill_mode`(`DELIVERY`/`PICKUP`), `price`(`NUMERIC(10,2)`), `buy_qty`, `gift_qty`, `status`
4. **`container_configs`（容器标准与总账表）**：
   - `tenant_id`, `container_type`(`BUCKET`/`BAG`), `unit_deposit`, `total_qty`, `in_station_qty`, `in_transit_qty`, `member_held_qty`, `inspecting_qty`, `abnormal_qty`, `warn_threshold`
   - **恒等式约束**：`CHECK (total_qty = in_station_qty + in_transit_qty + member_held_qty + inspecting_qty + abnormal_qty)`
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
