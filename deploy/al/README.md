# al 生产部署

入口：`https://kunlun.idalee.cn/admin`。al 通过 `ssh al` 管理。应用发布目录为 `/opt/kunlun/releases/<source-sha>`，Compose 和仅 root 可读的 `.env` 位于 `/opt/kunlun`。

- 独立 PostgreSQL 16 数据卷 `kunlun_postgres_data`、业务库 `kunlun_prod`、非超级用户 `kunlun_app`；不导入本地测试数据，禁止启用 `SeedDemoData`。
- 应用无公网端口，前端只在本机 `127.0.0.1:18085` 提供诊断入口。公网入口由既有 `atlas-wiki-gateway-1` Caddy 反向代理。
- 三个基础镜像在 `.env` 中固定 digest。密钥和初始管理员密码只保存在服务器受限配置中，不进入仓库或发布归档。
- 管理端、员工端和会员端采用仓库 `deploy/nginx.conf` 的同一套路由；域名根路径跳转管理后台。

## 发布

1. 本机运行 `pnpm install --frozen-lockfile && pnpm build`，执行后端测试和前端检查。
2. 运行 `dotnet publish services/Kunlun.WaterStation -c Release -r linux-x64 --self-contained false -o .publish/al/api`。
3. 使用 `deploy/al/prepare-release.sh .publish/al/release-<sha>` 生成纯发布文件，并归档上传至 al 的版本目录。
4. 初次部署将 `compose.yaml`、`init-database.sh` 放在 `/opt/kunlun`；创建权限 600 的 `.env`，设置 `POSTGRES_IMAGE`、`ASPNET_IMAGE`、`NGINX_IMAGE`（digest），`POSTGRES_ADMIN_PASSWORD`、`KUNLUN_DB_PASSWORD`、`KUNLUN_JWT_KEY`、`KUNLUN_ADMIN_USER`、`KUNLUN_ADMIN_PASSWORD` 和 `RELEASE_DIR`。
5. `docker compose --project-directory /opt/kunlun -f /opt/kunlun/compose.yaml config --quiet` 验证后，`up -d --wait`。首次初始化会创建管理员；后续启动不会重置其密码。
6. 网关备份后加入 `Caddyfile.fragment` 和 HTTP 重定向。分别执行 `caddy validate`、`nginx -t`，通过后热加载，保留其他站点配置。现有 Caddy 使用 `admin off`，以 `docker kill --signal=USR1 atlas-wiki-gateway-1` 重读原配置文件；不启用管理 API。HTTP 网关使用 `docker exec gitlab-proxy nginx -s reload`。
7. 核对 HTTPS 证书、管理端静态文件哈希、管理员登录与 `/healthz`，并检查既有站点仍正常。

## HTTPS 自动续期

证书由现有 Caddy 的 ACME 自动管理，使用 443 端口的 TLS-ALPN 验证。持久目录 `/opt/atlas-wiki/caddy-data` 保存证书和续期状态。无需单独 certbot 定时器。保持域名 A 记录指向 al、公网 443 可达、网关容器运行及持久目录可写。

```sh
ssh al 'docker logs --since 24h atlas-wiki-gateway-1 2>&1 | grep -E "kunlun.idalee.cn|renew|certificate"'
```

HTTP 80 仅为本站配置 308 到 HTTPS，不改变既有站点。首次签发成功可证明 ACME 通道可用；未来到期前的自动续期由 Caddy 持续执行。

## WireGuard 与 k3s

al 的 `wg0` 为 `10.77.0.20/32`，连接 `39.105.178.224:51820`。路由范围为 `10.77.0.1/32` 和公司别名网段 `10.78.1.0/24`，MTU 1380、Keepalive 25 秒，`wg-quick@wg0` 开机启用。

- 控制面：`10.78.1.161:6443`；节点 SSH 使用对应 `10.78.1.x:22`。
- Traefik：`10.78.1.200`；Harbor：`10.78.1.201`。
- 仅提供网络可达性；k3s 管理凭据未复制到 al。
- 配置与私钥为 al 上 `/etc/wireguard/wg0.conf`（600），hub 客户端登记为 `al`。

## 诊断、备份和回退

```sh
ssh al 'cd /opt/kunlun && docker compose ps'
ssh al 'curl -fsS http://127.0.0.1:18085/healthz'
ssh al 'systemctl is-active wg-quick@wg0 && ip route get 10.78.1.161'
ssh al 'curl -fsS http://10.78.1.201/api/v2.0/ping'
```

数据库备份在服务器受限目录执行 `docker compose exec -T database pg_dump -U postgres -d kunlun_prod -Fc > /root/kunlun-backup.dump`（先 `umask 077`）。不要使用 `down -v`，也不要将生产备份放进仓库。

应用回退：将 `.env` 的 `RELEASE_DIR` 改为原版本，重新 `up -d --wait`；涉及数据库迁移时先确认旧版本兼容，不能直接覆盖数据库。首次部署失败可停止新增的 kunlun 服务并恢复网关备份。WireGuard 回退仅停止 al 的 `wg-quick@wg0` 并在 hub 吊销 `al` 客户端。

自动 HTTPS 与信号热加载依据：[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)、[Caddy 信号说明](https://caddyserver.com/docs/command-line#signals)。

## 首次部署验收（2026-10-27）

业务代码版本 `b22e77d`。独立库 `kunlun_prod` 初始会员 0、订单 0、管理员 1；数据库与 Web 健康检查通过。公网前端哈希与本地发布文件一致，登录及 API 验证通过。Let's Encrypt 证书已签发，SAN 为 `kunlun.idalee.cn`，当前有效期至 2027-01-25 00:11:05 UTC；Caddy 已记录自动续期信息。HTTP 返回 308，既有 `y.idalee.cn`、`wloc.idalee.cn` 仍返回 200。
