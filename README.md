# ZackCloud Lite（扎克云 Lite）

ZackCloud Lite V0.6 是供少数朋友免费使用的私人订阅整理与静态分发服务。正式朋友订阅入口为 `https://sub.zackcloud.site`；V0.3/V0.4 的 Cloudflare Worker、KV snapshot 和 updater 数据链路保持不变。Worker 只分发预生成配置，不承担代理流量，也不在朋友刷新订阅时访问上游。

V0.6 新增一个彼此独立的用户门户 Worker。门户负责注册、登录、审批和订阅凭据生命周期；订阅 Worker 继续只负责认证和分发。门户的计划入口是 `https://zackcloud.site`，订阅入口仍为 `https://sub.zackcloud.site`。

## V0.6 双 Worker 架构

```text
浏览器 → zackcloud.site → Portal Worker → D1 AUTH_DB
Clash / Mihomo → sub.zackcloud.site → Subscription Worker → D1 AUTH_DB → KV snapshot
管理员 → Portal Worker → 审批 / 禁用 / 轮换 / 审计
```

- `portal/` 是独立的 `zackcloud-portal` Worker，拥有独立 Wrangler 配置和 D1 migration。
- 新用户注册后状态为 `PENDING`，只有管理员审批成功才会在同一 D1 batch 中创建订阅凭据并变为 `APPROVED`。
- 用户登录后可看到申请状态；仅已审批且未过期的用户能通过受保护 API 获取自己的订阅地址。初始 HTML 不包含原始 token。
- Subscription Worker 优先用 token 的 SHA-256 查 D1；查不到或 D1 暂不可用时继续兼容现有 `FRIENDS_CONFIG_JSON` / `ALLOWED_TOKENS`。D1 中明确存在但已禁用、拒绝或过期的记录不会回退绕过状态。
- 现有 Friend Management CLI 保留作为恢复与兼容工具，Portal 不读取或依赖本地 `friends.json`。

### D1 schema 与本地开发

`portal/migrations/0001_auth.sql` 创建 `users`、`subscription_credentials`、`sessions` 和 `audit_logs`。本地 D1 状态保存在 Wrangler 的忽略目录中，不得提交。

所有命令仍必须在 WSL 中运行：

```bash
npm run db:migrate:local
npm run portal:test
npm run portal:dev
```

本地门户由 Wrangler 提供；注册、登录、审批、禁用、启用、设置期限、轮换、删除和审计均有自动化生命周期测试。`deploy:dry-run` 会分别构建 Subscription Worker 和 Portal Worker，但不会部署。

### 门户 secrets 与安全模型

生产配置只应通过 Worker Secret 或 env binding 提供。所需名称为 `TOKEN_ENCRYPTION_KEY`、`ADMIN_USERNAME`、`ADMIN_PASSWORD_HASH`，可选名称为 `REGISTRATION_INVITE_HASH`、`TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY`、`PORTAL_ORIGIN`、`ZACKCLOUD_PUBLIC_BASE_URL`。不要把值写入 Git、README 或 shell 历史。

- 用户密码使用运行时原生 WebCrypto PBKDF2-HMAC-SHA256（16 字节随机 salt，默认 20,000 次）；该参数按 Cloudflare Workers Free plan 的真实 CPU 指标选定，管理员密码使用同一版本化可移植 hash 格式。
- 管理员 hash 工具只从 stdin 读取密码，不接受命令行参数：`npm run admin:hash-password`。
- 订阅 token 使用 256-bit 安全随机数；D1 保存 SHA-256 查找值和 AES-256-GCM 密文，不保存明文。
- 会话是不可预测的 opaque token，D1 只保存 hash；cookie 使用 `HttpOnly`、`Secure`、`SameSite=Lax`。
- 所有状态变更同时验证精确 Origin 和 CSRF token。门户发送 CSP、frame、MIME sniffing、referrer 和 permissions 安全响应头。
- Cloudflare Turnstile 为可选项；配置 site/secret key 后注册页和服务端验证同时启用，未配置时不加载第三方脚本。

管理员账号不是 D1 普通用户。上线前通过 secrets 配置管理员用户名和 hash；审批、拒绝、禁用、启用、过期时间、token 轮换和删除都会写入 `audit_logs`。仓库配置不会自动绑定根域，也不包含 production 部署脚本。

### V0.6 staging 部署准备

远程 D1 使用数据库名 `zackcloud-auth`，Portal 与 Subscription Worker 都以 `AUTH_DB` 绑定同一个数据库。Portal staging Worker 名固定为 `zackcloud-portal-staging`；不要把 `zackcloud.site` 根域绑定到 staging Worker。完整生命周期验证前，只允许使用 workers.dev，或由管理员在 Cloudflare Dashboard 手工绑定 `portal-staging.zackcloud.site`。

首次准备或核对远程 migration 时必须明确使用 `--remote`：

```bash
npx wrangler d1 migrations list zackcloud-auth --remote --config portal/wrangler.jsonc
npx wrangler d1 migrations apply zackcloud-auth --remote --config portal/wrangler.jsonc
```

Portal 缺少任一强制 secret 时不得部署。下面的 WSL 模板不会把密码、hash 或加密密钥写入参数、文件或终端标准输出：

```bash
read -r -p "Admin username: " ZACKCLOUD_ADMIN_USERNAME_INPUT
printf '%s' "$ZACKCLOUD_ADMIN_USERNAME_INPUT" | npx wrangler secret put ADMIN_USERNAME --config portal/wrangler.jsonc
unset ZACKCLOUD_ADMIN_USERNAME_INPUT

read -r -s -p "Admin password: " ZACKCLOUD_ADMIN_PASSWORD_INPUT
printf '\n'
printf '%s' "$ZACKCLOUD_ADMIN_PASSWORD_INPUT" \
  | npm run --silent admin:hash-password \
  | npx wrangler secret put ADMIN_PASSWORD_HASH --config portal/wrangler.jsonc
unset ZACKCLOUD_ADMIN_PASSWORD_INPUT

openssl rand -base64 32 \
  | tr '+/' '-_' \
  | tr -d '=\n' \
  | npx wrangler secret put TOKEN_ENCRYPTION_KEY --config portal/wrangler.jsonc
```

`TOKEN_ENCRYPTION_KEY` 必须解码为 32 bytes；上述命令直接生成符合代码要求的 base64url 值并通过管道提交。设置后只核对 secret 名称，不读取值：

```bash
npx wrangler secret list --config portal/wrangler.jsonc
```

只有确认三项名称齐全后，才可部署 `zackcloud-portal-staging`。Turnstile 在 staging 可暂不配置，相关 binding 与服务端验证支持保留。

## 三条数据流

订阅更新：

```text
Updater → upstream → converter → validator → Cloudflare KV
```

用户刷新订阅：

```text
Clash / Mihomo → Cloudflare Worker → token auth → KV snapshot
```

真实代理流量：

```text
Clash / Mihomo → 直接连接原上游 proxy node → Internet
```

开发者电脑不需要常开。GitHub updater 可用时每 6 小时自动更新；如果 GitHub runner 被上游拒绝，可以偶尔在本地运行 Publisher，朋友继续读取 KV 中的 last-known-good snapshot。

## V0.3 核心链路

- `GET /health`：返回服务名和 `0.3.0` 版本，不暴露 KV 或上游状态。
- `GET /`：私人服务中文首页。
- `GET /sub/:token`：验证朋友后读取 `SUBSCRIPTION_STORE` 的 `subscription:current`。
- Snapshot 严格验证 schema、YAML、代理数量和 SHA-256。
- 订阅支持强 ETag；匹配 `If-None-Match` 时返回 `304`。
- 仅从 snapshot 透传 `subscription-userinfo` 和 `profile-update-interval`。
- KV 缺失、JSON 损坏、schema 不支持、YAML 为空或 hash 不匹配统一返回安全的 `503`，绝不实时回源。
- `FRIENDS_CONFIG_JSON` 支持启用和过期时间；`ALLOWED_TOKENS` 仅作为 legacy 兼容。
- Publisher 在覆盖 current 前验证全部节点非名称字段、名称唯一性、代理组引用和 metadata 白名单。
- 上游请求使用 `clash.meta` User-Agent，限制 10 秒和 5 MiB。

架构取舍详见 [docs/design-v0.3.md](docs/design-v0.3.md)。

## 强制 WSL 开发环境

本项目位于 Windows D 盘，但所有 Node/npm/Vitest/Wrangler 命令必须从 WSL 执行，避免 Windows 与 Linux 原生依赖混装：

```powershell
wsl.exe bash -lc 'cd "/mnt/d/扎克云/zackcloud-lite" && npm ci'
wsl.exe bash -lc 'cd "/mnt/d/扎克云/zackcloud-lite" && npm test'
```

进入 WSL 后也可以直接运行：

```bash
cd "/mnt/d/扎克云/zackcloud-lite"
npm ci
npm test
npm run typecheck
npm run lint
npm run security-scan
npm run deploy:dry-run
```

`deploy:dry-run` 已明确指定 staging 环境，不会出现多环境歧义，也不会部署。

## 本地 Publisher

`.dev.vars` 只保存在本机并被 Git 忽略。其中的 `UPSTREAM_SUBSCRIPTION_URL` 仅供 Publisher 使用，不再是 Worker 运行时依赖。

只构建和验证，不写 KV：

```bash
npm run update:dry-run
```

验证成功并发布到 staging KV：

```bash
npm run update:local
```

命令只输出 HTTP 状态、格式、数量、地区/协议聚合、验证结果和 hash 前 8 位；不会输出上游地址、节点、订阅正文或完整 hash。临时 snapshot 保存在系统临时目录，权限为 `0600`，结束时主动删除。

## Staging KV 初始化

先检查现有 namespace：

```bash
npm run setup:kv
```

只有确认需要创建时才执行：

```bash
npm run setup:kv -- --create
```

脚本只创建或复用 `zackcloud-lite-staging-SUBSCRIPTION_STORE`，并更新 staging 的 `SUBSCRIPTION_STORE` binding；不会删除资源、创建 production Worker 或修改 DNS。

## Friends 配置

推荐把以下内容作为 staging Worker Secret `FRIENDS_CONFIG_JSON`，真实值不得写入仓库：

```json
[
  {
    "token": "example-token-a",
    "name": "friend-a",
    "enabled": true,
    "expiresAt": null
  }
]
```

未知、禁用、过期和格式非法的 token 都统一返回 `404`。旧的 `ALLOWED_TOKENS` 暂时继续支持。

## Friend Management

正式 friend store 默认位于 `~/.local/share/zackcloud-lite/friends.json`。目录权限为 `0700`，文件权限为 `0600`，更新采用同目录临时文件、同步落盘后原子 rename。可通过 `ZACKCLOUD_FRIENDS_FILE` 指向另一个私有文件；该文件永远不能提交到 Git。

`friend:add`、`friend:rotate` 和 `friend:add-and-deploy` 默认生成 `https://sub.zackcloud.site/sub/<token>`。`ZACKCLOUD_PUBLIC_BASE_URL` 仍可覆盖入口，例如用于隔离环境；`workers.dev` 地址只保留为调试或 staging 备用入口，不再是朋友默认地址。

从 V0.3 已同步的私有 `staging-friends.json` 首次迁移时，可运行 `npm run friends:migrate-staging`。该操作只在新 store 尚不存在时执行，保留现有凭据并补齐本地审计时间字段，不会打印配置正文。

以下示例必须在 WSL 中运行：

```bash
npm run friend:add -- "Alice"
npm run friend:list
npm run friend:disable -- "Alice"
npm run friend:enable -- "Alice"
npm run friend:rotate -- "Alice"
npm run friend:expire -- "Alice" "2026-12-31T23:59:59+08:00"
npm run friend:expire -- "Alice" never
npm run friend:remove -- "Alice" --yes
```

`friend:add` 和 `friend:rotate` 只在成功时输出一次新的完整订阅 URL；其他命令最多显示 token 最后 4 个字符。需要覆盖默认入口时，可设置 `ZACKCLOUD_PUBLIC_BASE_URL="https://example.invalid"`。

把验证后的 friend store 安全写入 staging Worker Secret：

```bash
npm run friends:deploy
```

JSON 通过 stdin 交给 Wrangler，不进入 shell 参数，也不打印正文。默认目标严格为 `zackcloud-lite-staging`；如确有需要可使用 `ZACKCLOUD_WORKER_NAME` 覆盖。新增并同步可以合并为：

```bash
npm run friend:add-and-deploy -- "Bob"
```

远端失败时本地新增记录会保留，命令会明确报告本地已更新、远端未更新，并且不会输出订阅 URL。

使用明确提供的 staging URL 验证单个朋友：

```bash
STAGING_URL="https://example.invalid" npm run friend:verify -- "Alice"
```

校园网环境可额外设置 `ZACKCLOUD_TEST_PROXY`；代理地址不写入 Worker 或源码。

只验证正式自定义域名时：

```bash
CUSTOM_DOMAIN_URL="https://sub.zackcloud.site" npm run verify:staging
```

命令只输出自定义域名的 health、订阅状态、ETag 验证和总结果，不输出 token、完整订阅 URL 或正文。

旋转 token 会阻止旧链接继续刷新订阅，但无法即时删除朋友设备已经下载的节点连接信息。真正即时废除底层节点凭据，仍需由 upstream provider 更换相关凭据。

## GitHub Actions updater

[.github/workflows/update-subscription.yml](.github/workflows/update-subscription.yml) 支持手动触发和每 6 小时运行。仓库需要配置：

- `UPSTREAM_SUBSCRIPTION_URL`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_KV_NAMESPACE_ID`

朋友 token 不进入 GitHub Actions。Updater 若遇到 `http_403`、`http_429`、`timeout`、`network_error`、`response_too_large` 或格式错误，会输出安全原因、失败退出且不写 KV。

## Staging 部署顺序

安全迁移顺序固定为：

1. 创建或复用 staging KV namespace。
2. 运行本地 Publisher，写入第一个验证通过的 snapshot。
3. `npx wrangler deploy --env staging` 部署 V0.3 Worker。
4. 通过本机现有 HTTP 代理验证 health、无效 token、有效 token 和 ETag `304`。
5. 全部确认后，才可删除 staging Worker 中旧的 `UPSTREAM_SUBSCRIPTION_URL` Secret。

不得把这些命令改为 top-level 或 production 部署。

## 安全边界

- 不记录请求 URL、token、上游地址、订阅正文、节点或代理凭据。
- 不在项目目录保存真实 snapshot，不上传订阅 Artifact。
- 不透传上游网站、Location、Cookie、Server 或异常正文。
- D1 仅保存门户身份、加密订阅凭据、会话 hash 与安全审计；订阅 YAML 仍只保存在现有 KV snapshot，不进入 D1。
- 不使用 R2、Durable Objects，也不把真实订阅、上游地址或客户端代理流量写入数据库。
- 不实现 Xray、Mihomo、VLESS、Trojan、WireGuard、TCP、UDP 或 WebSocket 流量中转。
- `.dev.vars`、`.env`、`node_modules`、`dist` 和 Wrangler 临时文件均被 Git 忽略。
