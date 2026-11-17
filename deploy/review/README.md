# Apple 审核演示环境

iOS 员工端的登录页提供「审核演示」。新开的 WebView 使用独立的会话数据，API 请求只发往 `https://kunlun-test.idalee.cn/apple-review/api/`。退出演示回到正式登录。这里使用与正式端相同的员工界面和接口，仅包含虚构业务数据。

## 部署

- 宿主机 al 的部署目录是 `/opt/kunlun-review`，运行独立的 `kunlun-review` Compose 项目。数据库名为 `kunlun_review`，使用独立卷、应用账号、JWT 签发方和密钥。请勿恢复任何业务环境的数据库备份。
- API 服务名为 `review-api`，不能叫 `api`。Compose 会把服务名自动加为它所在每个网络的别名，包括与正式站、测试站共用的 Caddy 网络 `atlas-wiki_default`；而正式站和测试站的 nginx 都转发到 `http://api:8080`。2026-11-18 审核 API 曾以 `api` 名义上线，测试站 web 重建后就把请求转给了审核库。每次启动或重建后，在 al 上确认 `docker exec kunlun-web getent hosts api` 和 `docker exec kunlun-test-web-1 getent hosts api` 返回的是各自 API 的地址，而不是审核 API 在 `atlas-wiki_default` 上的地址。
- 将水站 API 的 Linux x64 Release 发布产物放在独立目录，通过 `REVIEW_RELEASE_DIR` 指定。将本目录的 `compose.yaml`、`init-database.sh` 和 `seed.py` 放入部署目录。通过权限 600 的 `.env` 填写 `POSTGRES_IMAGE`、`ASPNET_IMAGE`（使用已经验证的镜像摘要）以及独立随机生成的 `REVIEW_DB_ADMIN_PASSWORD`、`REVIEW_DB_PASSWORD`、`REVIEW_JWT_KEY`、`REVIEW_ADMIN_PASSWORD`、`REVIEW_STAFF_PASSWORD`。执行 `docker compose up -d --wait`。
- 仅在 al 上，以加载 `.env` 的环境执行 `python3 seed.py`。脚本核验本机 `127.0.0.1:18087` 使用审核库，再创建 `apple_review` 店员、虚构会员、库存、水票及演示水单。不要向 Apple 提供管理员凭据。
- 在既有 `kunlun-test.idalee.cn` Caddy 站点中，将 `handle_path /apple-review/* { reverse_proxy kunlun-review-api:8080 }` 放在测试站的兜底反向代理之前。先验证 Caddy 配置，并检查正式站、测试站与审核 API 的健康端点分别返回各自的数据库。
- 在 Caddy 的生产域名增加 `/privacy/ios` 和 `/support/ios` 两条静态页面路由，指向本目录 `pages/` 中的对应文件。仅这两条公开路径提供静态文件，其他请求照常转发。

在 App Store Connect「App 审核信息」提供演示店员账号，说明在 App 登录页点「审核演示」，然后使用演示凭据登录。审核期间应保持此环境和凭据有效。
