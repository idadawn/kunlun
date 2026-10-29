# 小程序独立测试服务

固定入口：`https://kunlun-test.idalee.cn`，管理端 `/admin`；与 `kunlun.idalee.cn` 的业务数据隔离。

- al 部署目录 `/opt/kunlun-test`，Compose 项目 `kunlun-test`。
- 独立 PostgreSQL 数据卷和数据库 `kunlun_test`、账号 `kunlun_test_app`、JWT 密钥及 issuer/audience。数据库不开放公网端口。
- 宿主机诊断口 `127.0.0.1:18086`，既有 Caddy 经 `kunlun-test-web:8080` 代理 HTTPS。
- `ASPNETCORE_ENVIRONMENT=Testing`、`MiniPayments:Mode=Mock`；使用真实数据库事务模拟支付，无微信扣款。`SeedDemoData=false`，初始化通过业务 API 完成。

## 构建与发布

```sh
pnpm install --frozen-lockfile
pnpm build
dotnet publish services/Kunlun.WaterStation -c Release -r linux-x64 --self-contained false -o .publish/test/api
deploy/test/prepare-release.sh .publish/test/release-SOURCE_SHA
```

将发布目录上传到 `/opt/kunlun-test/releases/SOURCE_SHA`；将本目录的 `compose.yaml`、`init-database.sh` 放在 `/opt/kunlun-test`。服务器上创建权限 600 的 `.env`，使用独立随机密码，填写：

```text
POSTGRES_IMAGE=postgres@sha256:...
ASPNET_IMAGE=mcr.microsoft.com/dotnet/aspnet@sha256:...
NGINX_IMAGE=nginx@sha256:...
POSTGRES_ADMIN_PASSWORD=独立随机密码
KUNLUN_DB_PASSWORD=独立随机密码
KUNLUN_JWT_KEY=至少32字节独立随机值
KUNLUN_ADMIN_USER=test_admin
KUNLUN_ADMIN_PASSWORD=独立随机密码
RELEASE_DIR=/opt/kunlun-test/releases/SOURCE_SHA
```

镜像需固定 digest，可复用 al 上已验证的基础镜像。先运行 Compose `config --quiet` 再 `up -d --wait`。网关备份后添加 `Caddyfile.fragment`，通过 `caddy validate` 后用现有 Caddy 的 `USR1` 信号重读配置，保持原站点不变。HTTP 网关添加 `http-redirect.conf`，通过 `nginx -t` 后热加载。不要对正式库启用 Mock。

## 测试账号初始化

在权限 600 的私有 JSON 文件中填写 `apiBase`、`admin`、`staff` 及两个 `members` 的 `account/password`，不要提交到 Git。管理员密码必须与首次 Bootstrap 一致。

```sh
node deploy/test/seed.mjs PRIVATE_ACCESS_JSON
```

该脚本只接受固定的测试域名，并核对 `/api/mini-config` 的测试标记和 MOCK 能力；创建店员和两名测试会员，通过业务接口一次性登记初始水票、押金及袋桶入库。幂等键避免重跑重复赠票或重复入库。再次部署保留数据，不清空数据库、不覆盖已有账号密码。

## 小程序接入与验收

测试号后台的 **request 合法域名**加入 `https://kunlun-test.idalee.cn`，保留 HTTPS、TLS 和证书校验。小程序不需要 AppSecret 或商户密钥。当前使用门店开通的账号密码，尚未实现微信身份绑定。

```sh
KUNLUN_MINI_MODE=api \
KUNLUN_MINI_APPID=自己的测试AppID \
KUNLUN_MINI_API_BASE=https://kunlun-test.idalee.cn \
pnpm --filter @kunlun/wechat-mini build
node apps/wechat-mini/scripts/verify-backend.cjs PRIVATE_ACCESS_JSON
```

验收脚本加载**实际打包的小程序 API 模块**，以各自独立的存储和会话模拟多部手机，`wx.request` 桥接到真实 HTTPS 服务。验证登录、跨端地址和订单可见、模拟支付取消/失败/成功、重复入账保护、接单/交付/取消、零售补差、押金幂等收取、会员数据隔离和退出失效。它只修改测试库，保留完成/取消的验收水单供查看；不会调用微信收款。

只通过接口测试不代表已完成手机验收。还需在微信开发者工具以保留域名校验的 API 构建登录，生成预览码，在手机上核对真实网络及页面行为。

## 回退与诊断

```sh
ssh al 'cd /opt/kunlun-test && docker compose ps'
curl -fsS https://kunlun-test.idalee.cn/api/mini-config
curl -fsS https://kunlun-test.idalee.cn/healthz
```

回退时只修改测试目录 `.env` 的 `RELEASE_DIR` 到先前版本并 `up -d --wait`。不执行 `down -v`，不接触 `/opt/kunlun` 的生产数据库。测试环境清理须另行确认，不随代码部署删除测试数据。
