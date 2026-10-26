# Kunlun（昆仑）· 绿麒麟水站会员管理系统

> **绿麒麟水站｜小分子团弱碱活性水** —— *鲜活每一滴，好水到你家*

基于 [Qian](https://github.com/idadawn/qian) 平台插件规范与 [Kun](https://github.com/idadawn/kun)（.NET 10 云原生框架）构建的水站数字化会员管理系统，采用 **Monorepo** 架构组织后端服务、共享领域模型、管理端 PC 与微信小程序。

## 业务入口

- [管理后台 (`admin.html`)](./admin.html)：管理员登录后办理会员、订单、账务与设置。
- [员工工作台 (`staff.html`)](./staff.html)：独立员工登录入口，适配移动设备。
- [会员中心 (`member.html`)](./member.html)：会员登录后查看本人权益与预约用水。

入口之间不展示角色切换导航；根入口跳转管理后台。页面沿用设计 HTML 的内容布局，移除样机外壳、演示目录和模拟成功操作。

## 文档导航 (`docs/`)

- [产品需求文档 (`docs/PRD.md`)](./docs/PRD.md)
- [技术架构、权限与四账数据库设计 (`docs/architecture.md`)](./docs/architecture.md)

## 仓库结构

| 目录 | 包名 / 命名空间 | 说明 |
| --- | --- | --- |
| `services/Kunlun.WaterStation` | `Kunlun.WaterStation` (`kunlun.waterstation`) | .NET 10 后端业务插件与独立宿主（PostgreSQL 16 + RLS + 四账原子命令） |
| `services/Kunlun.WaterStation.Tests` | `Kunlun.WaterStation.Tests` | 集成与真实验收测试（覆盖 PRD `AC-01` ~ `AC-20`） |
| `packages/shared` | `@kunlun/shared` | 三端共享的 TypeScript 类型、四账核算公式与权限码常量 |
| `apps/admin-pc` | `@kunlun/admin-pc` | 管理端 PC（React 18 + Vite + `@idadawn/yue`） |
| `apps/mini-app` | `@kunlun/mini-app` | 员工端 + 会员端微信小程序（Taro 4 + React 18） |

## 本地启动与验收

先显式设置 `ConnectionStrings__Kunlun`、`Kunlun__Jwt__SigningKey`，以及首次初始化所需的 `Kunlun__Bootstrap__Username` / `Kunlun__Bootstrap__Password`（见 `.env.example`）。应用不自动读取 `.env.local`，默认不创建演示账号。已有员工的用户名为原工号；会员登录账号在管理端会员详情中设置。

```sh
dotnet run --project services/Kunlun.WaterStation --urls http://127.0.0.1:5188
pnpm sync:frontends
pnpm --filter @kunlun/admin-pc dev
```

管理端 `/admin.html`、员工端 `/staff.html`、会员端 `/member.html` 共用 `/api` 代理。部署时将 `/api` 反向代理到后端。根目录 HTML 和 `assets/` 是当前页面唯一维护源，`pnpm build` 自动同步副本并检查 TypeScript。

后端验收必须显式设置 `KUNLUN_TEST_DATABASE_URL`（数据库名包含 `test`，账号需有创建测试库权限），再运行 `dotnet test Kunlun.slnx`。测试自行创建、销毁独立数据库，不使用业务库。


## 已接通业务

- 三端用户名密码登录、会员账号设置、员工账号管理、修改密码与退出失效。
- 八档固定水票套餐（100 / 499 元，袋装 5L、桶装 15L），后台可编辑，历史充值保留原价快照。
- 赠水优惠券配置、发放、领取限制和充值核销。
- 水票按充值批次预占、核销、取消释放；管理员按原价退清剩余付费票并回收赠票。
- 管理端、会员端与员工端共用真实 PostgreSQL 数据；沿用设计 HTML 的页面结构。当前入口为 H5，微信原生打包和在线支付不在本次交付范围。
