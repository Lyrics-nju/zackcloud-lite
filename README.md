# ZackCloud Lite（扎克云 Lite）

ZackCloud Lite V0.3 是供少数朋友免费使用的私人订阅整理与静态分发服务。Cloudflare Worker 只分发预生成配置，不承担代理流量，也不在朋友刷新订阅时访问上游。

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

## V0.3 功能

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
- 不使用 D1、R2、Durable Objects、数据库或完整管理后台。
- 不实现 Xray、Mihomo、VLESS、Trojan、WireGuard、TCP、UDP 或 WebSocket 流量中转。
- `.dev.vars`、`.env`、`node_modules`、`dist` 和 Wrangler 临时文件均被 Git 忽略。
