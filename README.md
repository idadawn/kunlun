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
