# Kunlun（昆仑）· 绿麒麟水站会员管理系统

> **绿麒麟水站｜小分子团弱碱活性水** —— *鲜活每一滴，好水到你家*

基于 [Qian](https://github.com/idadawn/qian) 平台插件规范与 [Kun](https://github.com/idadawn/kun)（.NET 10 云原生框架）构建的水站数字化会员管理系统，采用 **Monorepo** 架构组织后端服务、共享领域模型、管理端 PC 与员工/会员手机 H5。

## 业务入口

- 管理后台 `/admin`：管理员登录后办理会员、订单、账务与设置。
- 员工工作台 `/staff`：独立员工登录入口，适配手机。
- Android 员工端：将员工页面打包进 APK，以内置 WebView 运行，见 [Android 构建与模拟器安装](apps/android-staff/README.md)。
- 会员中心 `/member`：会员登录后只读查看本人水票、用水与充值记录、押金和桶袋；下单、充值、交退押金都到店或找送水员办理。
- iOS 会员客户端：SwiftUI 原生水票、记录、押金与账户页面，支持 iOS 17+，见 [iOS 开发与验证说明](apps/ios-member/README.md)。

根入口跳转管理后台。原生微信小程序已停止建设并移除，手机浏览器端继续使用上述两个 H5 入口。

## 文档导航 (`docs/`)

- [产品需求文档 (`docs/PRD.md`)](./docs/PRD.md)
- [技术架构、权限与四账数据库设计 (`docs/architecture.md`)](./docs/architecture.md)

## 仓库结构

| 目录 | 包名 / 命名空间 | 说明 |
| --- | --- | --- |
| `services/Kunlun.WaterStation` | `Kunlun.WaterStation` (`kunlun.waterstation`) | .NET 10 后端业务插件与独立宿主（PostgreSQL 16 + RLS + 四账原子命令） |
| `services/Kunlun.WaterStation.Tests` | `Kunlun.WaterStation.Tests` | 集成与真实验收测试（覆盖 PRD `AC-01` ~ `AC-20`） |
| `packages/shared` | `@kunlun/shared` | 三端共享的 TypeScript 类型、API 客户端、路由表、四账核算公式与权限码常量 |
| `packages/ui` | `@kunlun/ui` | 品牌样式与 React 组件：登录门禁、弹窗、套餐选择、收货地址簿、员工业务弹窗 |
| `apps/admin-pc` | `@kunlun/admin-pc` | 管理端 PC（React 18 + Vite + React Router） |
| `apps/mini-app` | `@kunlun/mini-app` | 员工端 `/staff` + 会员端 `/member` H5（React 18 + Vite） |
| `apps/android-staff` | `cn.idalee.kunlun.staff` | Android 员工端 APK（内置页面、独立窗口，Android 8.0+） |
| `apps/ios-member` | `KunlunMember` | 原生 iOS 会员客户端（SwiftUI + App Intents，只读业务记录） |

## 本地启动与验收

先显式设置 `ConnectionStrings__Kunlun`、`Kunlun__Jwt__SigningKey`，以及首次初始化所需的 `Kunlun__Bootstrap__Username` / `Kunlun__Bootstrap__Password`（见 `.env.example`）。应用不自动读取 `.env.local`，默认不创建演示账号。已有员工的用户名为原工号；会员登录账号在管理端会员详情中设置。

```sh
dotnet run --project services/Kunlun.WaterStation --urls http://127.0.0.1:5188
pnpm --filter @kunlun/admin-pc dev   # http://127.0.0.1:5173/admin
pnpm --filter @kunlun/mini-app dev   # http://127.0.0.1:5174/member 与 /staff
```

两个开发服务器都把 `/api` 代理到后端，功能页采用 `/admin/plans`、`/member/records` 等路径，支持直接访问和刷新；`.html` 地址一律返回 404。`pnpm build` 先做 TypeScript 检查再构建，产物部署方式见 `deploy/nginx.conf`。

后端验收必须显式设置 `KUNLUN_TEST_DATABASE_URL`（数据库名包含 `test`，账号需有创建测试库权限），再运行 `dotnet test Kunlun.slnx`。测试自行创建、销毁独立数据库，不使用业务库。


## 已接通业务

- 三端用户名密码登录、会员账号设置、员工账号管理、修改密码与退出失效。
- 水品新增时同时填写配套桶/袋类型、容量和押金单价；每种水品独立管理桶袋库存、押金、领还和报废，即使同为桶装水也不能混用。容量和容器类型固定，换规格需新增水品。加错且没有套餐、单据或库存记录的水品可删除；各水品分别建充值套餐、记自提/配送水票。默认两种水品（袋装 5L、桶装 15L）各有 100 / 499 元套餐，后台可编辑，历史充值保留原价快照。
- 水票按充值批次预占、核销、取消释放；管理员按原价退清剩余付费票并回收赠票。
- 门店点单（员工端、管理端）：选水品加入购物袋后选择送水上门或到店取水；顾客在店取水时当场交付、登记换回空桶并收取需补押金。会员端只读，不能自助下单。
- 会员收货地址簿：每位会员可保存多个地址（收货地址、门牌号、联系人、手机号），由店员维护，联系人和手机号默认带出本人；配送下单从地址簿选择并保存地址快照。
- 员工账号可停用或删除（不能删除自己和最后一个管理员）。
- 管理端、员工端与会员端共用同一 PostgreSQL 数据。系统不接入任何在线支付：水费和押金都由店员线下收款后登记。


管理端侧边菜单按管理工作分组：经营总览；日常业务（水单管理、会员管理）；财务管理（水费充值、押金管理，分别汇总、筛选和导出，押金金额不计入水费；审核，店员充值时手动赠送的水票和店员办理的退押金、退水费要不要管理员审核，由该页两个开关决定，默认都要审核）；袋桶管理（袋桶库存、袋桶台账）；商品管理（水品与押金标准、充值套餐）；系统设置（员工账号）。待处理水单、待审核的赠送和退款、待确认报废和库存预警以菜单角标提示。充值套餐页可根据当前启用配置生成高清价目表 PNG；运行 `pnpm test:poster` 检查导出数据与门店价目表一致。


`packages/shared/src/routes.ts` 是三端路由清单，React Router、开发/预览服务器和 Nginx 配置都以它为准。`pnpm test:web` 验证路由表、Nginx 规则、开发与构建预览，`pnpm check:pages` 检查构建产物。充值表单使用分类套餐弹窗（按水品和领取方式分类），只可选择启用套餐。


桶和袋均按可回收周转资产管理，水袋新收押金 5 元/个。“袋桶库存”用问答式盘点维护：依次回答店里有多少能用的、客户手里有多少、店里有多少要报废；数不清的选“说不清，先记为待核实”，现存总量显示为“至少 N 个”。另可登记新买入库。现存总量 = 店里能用 + 客户手里（会员名下 + 未登记在外）+ 会员退回待报废。“袋桶台账”独立展示会员持有、全部周转流水和破损报废。破损归还先暂占原押金（可一键选择常用破损原因），确认报废时选择按原实收批次扣押金或不扣押金（水站承担），同步更新库存及财务流水。

## al 正式环境

管理端：<https://kunlun.idalee.cn/admin>。使用独立生产数据库，HTTPS 由 Caddy 自动续期；al 通过 WireGuard 访问 k3s。部署、回退和验收说明见 [al 运维文档](deploy/al/README.md)。


## 独立测试环境

独立测试入口 `https://kunlun-test.idalee.cn`：管理端 `/admin`，员工端 `/staff`，会员端 `/member`。测试库与正式库隔离，运行和验收见 [测试服务说明](deploy/test/README.md)。
