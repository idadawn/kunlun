# Kunlun（昆仑）· 绿麒麟水站会员管理系统

> **绿麒麟水站｜小分子团弱碱活性水** —— *鲜活每一滴，好水到你家*

基于 [Qian](https://github.com/idadawn/qian) 平台插件规范与 [Kun](https://github.com/idadawn/kun)（.NET 10 云原生框架）构建的水站数字化会员管理系统，采用 **Monorepo** 架构组织后端服务、共享领域模型、管理端 PC 与微信小程序。

## 在线交互原型（三端独立演示）

- [演示中心总入口 (`index.html`)](./index.html)
- [管理端 PC (`admin.html`)](./admin.html) —— 全屏桌面工作台
- [员工端微信小程序 (`staff.html`)](./staff.html) —— 微信小程序样机 + 顶部流程快切
- [会员端微信小程序 (`member.html`)](./member.html) —— 微信小程序样机 + 顶部流程快切

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
