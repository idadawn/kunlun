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
4. 将与发布包同一版本的 `compose.yaml`、`init-database.sh` 放在 `/opt/kunlun`。首次部署时创建权限 600 的 `.env`，设置 `POSTGRES_IMAGE`、`ASPNET_IMAGE`、`NGINX_IMAGE`（digest），`POSTGRES_ADMIN_PASSWORD`、`KUNLUN_DB_PASSWORD`、`KUNLUN_JWT_KEY`、`KUNLUN_ADMIN_USER`、`KUNLUN_ADMIN_PASSWORD` 和 `RELEASE_DIR`。
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

### 数据库备份

2026-11-17 确认的策略（PRD 第 16 章第 15 条）：每天 03:30（Asia/Shanghai）分别备份生产库 `kunlun_prod` 和测试库 `kunlun_test`，生产保留 14 天、测试保留 7 天，最多丢失约一天的数据。备份只存放在 al 上；服务器外副本尚未确定，目前防不了整机或云盘损坏。不要使用 `down -v`，也不要将生产备份放进仓库。

- 本目录的 `kunlun-db-backup.sh` 安装为 `/usr/local/sbin/kunlun-db-backup`，`kunlun-db-backup@.service` 和 `kunlun-db-backup@.timer` 放在 `/etc/systemd/system/`，启用 `kunlun-db-backup@prod.timer` 与 `kunlun-db-backup@test.timer`。服务器关机错过的运行会在开机后补跑。
- 每次运行先 `umask 077`；根分区剩余不足 1 GiB 时拒绝运行（磁盘与其他站点共用）。`docker compose exec -T database pg_dump -Fc` 写入临时文件，在容器内用 `pg_restore -f /dev/null` 完整读回后才改名为 `kunlun_prod-YYYYmmdd-HHMMSS.dump`。备份成功后才删除超过保留期的旧文件，连续失败也不会删掉最后的好备份。
- 备份目录 `/var/backups/kunlun/{prod,test}` 为 700、文件为 600，仅 root 可读。备份只含业务库：角色由 `init-database.sh` 按 `.env` 创建，`.env` 不在备份内。
- 每次结果在 `/var/log/kunlun-db-backup.log` 记一行（`OK`、`FAILED`、`pruned`、`RESTORE-CHECK`、`NOTIFY`），详细输出在 journal。失败的单元会出现在 `systemctl --failed`，并发邮件通知，见「备份失败邮件」。

```sh
ssh al 'systemctl list-timers "kunlun-db-backup@*"; tail -n 20 /var/log/kunlun-db-backup.log'
ssh al 'ls -lh /var/backups/kunlun/prod; journalctl -u kunlun-db-backup@prod -n 50 --no-pager'
```

发布前（尤其含数据库迁移时）先手动备份，再复制到 `keep/`。`keep/` 不参与自动清理，需人工删除：

```sh
ssh al 'systemctl start kunlun-db-backup@prod && tail -n 1 /var/log/kunlun-db-backup.log'
ssh al 'install -d -m 700 /var/backups/kunlun/prod/keep && cp -p /var/backups/kunlun/prod/kunlun_prod-<时间>.dump /var/backups/kunlun/prod/keep/'
```

更新脚本或单元时，把本目录的三个脚本和三个单元传到 al 上仅 root 可读的临时目录：脚本去掉 `.sh`、`.py` 后 `install -m 700` 到 `/usr/local/sbin/`，单元 `install -m 644` 到 `/etc/systemd/system/`，再 `systemctl daemon-reload`。首次安装还需 `systemctl enable --now kunlun-db-backup@prod.timer kunlun-db-backup@test.timer`，并按「备份失败邮件」建好配置文件；`kunlun-db-backup-notify@.service` 不需要 enable。

### 备份失败邮件

`kunlun-db-backup@.service` 设了 `OnFailure=kunlun-db-backup-notify@%n.service`。生产或测试备份以非零退出或超时后（手动 `systemctl start` 也算），systemd 会启动 `kunlun-db-backup-notify@kunlun-db-backup@prod.service.service` 这样的实例，由本目录的 `kunlun-db-backup-notify.py`（安装为 `/usr/local/sbin/kunlun-db-backup-notify`）发一封邮件；备份成功不会启动它。al 没有本地 MTA（`/usr/sbin/sendmail` 是 `lsb-invalid-mta` 占位），阿里云又封了出站 25 端口，所以脚本用系统自带 python3 的 smtplib 直接连邮箱服务商的 465（SSL）或 587（STARTTLS），不需要装软件包。

- 标题含失败的单元名和主机名。正文有单元的 `Result` 和退出码、`/var/log/kunlun-db-backup.log` 最后 10 行、本次运行的 journal 最后 20 行，以及排查和重跑命令。
- SMTP 服务器、账号、授权码和收件人只写在 al 的 `/etc/kunlun-db-backup-notify.conf`（root、600），格式见本目录 `kunlun-db-backup-notify.conf.example`。这些值不进仓库，也不要贴到聊天里。用 `ssh -t al nano /etc/kunlun-db-backup-notify.conf` 修改；文件权限被放宽或缺少必填项时，脚本拒绝发送。
- 网络错误重试两次（间隔 30 秒、60 秒）；用户名或授权码错误、收件人被拒等 5xx 回复不重试。结果记入日志（`NOTIFY sent` 或 `NOTIFY FAILED`）。发信也失败时，`systemctl --failed` 会同时列出备份单元和 `kunlun-db-backup-notify@…` 单元，`NOTIFY FAILED` 行末附有该通知单元的 journal 命令。
- al 的 journal 约 3G，查询很慢：`journalctl -u 'kunlun-db-backup-notify@*'` 这类通配符几分钟都出不了结果，写完整单元名的 `journalctl -u` 也要 25–35 秒。所以脚本改查 `_SYSTEMD_UNIT=<单元> + UNIT=<单元>`，并从本次运行开始前 1 分钟查起，约 7 秒；上限 120 秒，超时也照样发信。邮件里的排查命令用的是同一种写法。

改了配置或收件人后演练一次：起一个必然失败、挂同样 `OnFailure=` 的临时单元（对这个单元名，`%n` 展开后就是下面的值），不碰真实备份：

```sh
ssh al 'systemd-run --wait --unit=kunlun-db-backup-drill -p OnFailure=kunlun-db-backup-notify@kunlun-db-backup-drill.service.service /bin/sh -c "echo drill: simulated backup failure >&2; exit 1"'
ssh al 'sleep 5; while [ "$(systemctl show -p ActiveState --value kunlun-db-backup-notify@kunlun-db-backup-drill.service.service)" = activating ]; do sleep 5; done; tail -n 1 /var/log/kunlun-db-backup.log; systemctl reset-failed kunlun-db-backup-drill.service'
```

日志最后一行应为 `… NOTIFY sent unit=kunlun-db-backup-drill.service …`，收件人会收到标题为「数据库备份失败：kunlun-db-backup-drill.service（主机 jhs）」的邮件。如果是 `NOTIFY FAILED`，按行末命令查原因，修好后先 `systemctl reset-failed kunlun-db-backup-notify@kunlun-db-backup-drill.service.service` 再演练。

2026-11-17 验证：

- SMTP 配置填好前，失败的临时单元启动了通知单元，参数是正确的单元名，并记下 `NOTIFY FAILED … has no value for SMTP_HOST, …`。
- 挂同样 `OnFailure=` 的成功临时单元，以及当天两次手动备份（测试库 09:11、生产库 09:25），都没有启动通知单元。
- 配置填好后按上面的命令演练了两次（09:28、09:37），日志都是 `NOTIFY sent … attempt=1`，收件人收到了邮件。第一次组装邮件用了 22 秒，几乎都花在 `journalctl -u` 上；改成上面的查询后，整个通知用时 8 秒。

### 恢复演练

每月至少一次，以及每次发布前，对最新备份执行（PRD 14.3）：

```sh
ssh al 'kunlun-db-restore-check prod'
```

本目录的 `kunlun-db-restore-check.sh` 安装为 `/usr/local/sbin/kunlun-db-restore-check`。它用与线上相同的 postgres 镜像启动无网络的临时容器，按 `init-database.sh` 的方式建应用角色和库，执行 `pg_restore --single-transaction --exit-on-error`，再逐表对比与线上库的行数，结束后连同数据卷删除临时容器，不写线上库。第二个参数可指定备份文件。恢复报错或缺表即判定失败；备份之后的新写入会让个别表行数不同（如 `auth_audit_logs`），需人工确认。结果同样记入 `/var/log/kunlun-db-backup.log`。

2026-11-17 首次演练：`kunlun_prod-20261117-083602.dump`（80K，24 张表）和 `kunlun_test-20261117-083542.dump`（92K，25 张表）均恢复成功，行数与线上逐表一致。下面两种恢复方式也已在临时容器中照原样走通。

### 恢复数据库

覆盖生产数据需经技术评审和二次确认（PRD 12.4）。以下命令在 al 的 `/opt/kunlun` 中执行。

库还在、需要回到某份备份时：先 `docker compose stop api` 停止写入，再 `systemctl start kunlun-db-backup@prod` 保留当前状态。然后恢复到新库并交换库名，原库保留到核对无误：

```sh
docker compose exec -T database createdb -U postgres -O kunlun_app kunlun_prod_restore
docker compose exec -T database pg_restore -U postgres -d kunlun_prod_restore --single-transaction --exit-on-error < /var/backups/kunlun/prod/kunlun_prod-<时间>.dump
docker compose exec -T database psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'ALTER DATABASE kunlun_prod RENAME TO kunlun_prod_before_restore' -c 'ALTER DATABASE kunlun_prod_restore RENAME TO kunlun_prod'
docker compose start api
```

核对 `/healthz`、管理员登录和关键数据后，再执行 `docker compose exec -T database dropdb -U postgres kunlun_prod_before_restore`。

数据卷丢失时：用原 `.env` 执行 `docker compose up -d --wait database`，`init-database.sh` 会重建 `kunlun_app` 和空的 `kunlun_prod`；用上面的 `pg_restore` 命令把备份恢复到 `kunlun_prod`（`-d kunlun_prod`），再 `up -d --wait`。`.env` 也丢失时按「发布」第 4 步重新生成；JWT 密钥变化后所有人需要重新登录。

### 应用回退

将 `.env` 的 `RELEASE_DIR` 改为原版本，恢复与其匹配的 `compose.yaml` 后重新 `up -d --wait`。涉及数据库迁移时先确认旧版本兼容；不兼容时按「恢复数据库」回到发布前的 `keep/` 备份（迁移后的新数据会丢失），不能直接覆盖数据库。首次部署失败可停止新增的 kunlun 服务并恢复网关备份。WireGuard 回退仅停止 al 的 `wg-quick@wg0` 并在 hub 吊销 `al` 客户端。

自动 HTTPS 与信号热加载依据：[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)、[Caddy 信号说明](https://caddyserver.com/docs/command-line#signals)。

## 首次部署验收（2026-10-27）

业务代码版本 `b22e77d`。独立库 `kunlun_prod` 初始会员 0、订单 0、管理员 1；数据库与 Web 健康检查通过。公网前端哈希与本地发布文件一致，登录及 API 验证通过。Let's Encrypt 证书已签发，SAN 为 `kunlun.idalee.cn`，当前有效期至 2027-01-25 00:11:05 UTC；Caddy 已记录自动续期信息。HTTP 返回 308，既有 `y.idalee.cn`、`wloc.idalee.cn` 仍返回 200。
