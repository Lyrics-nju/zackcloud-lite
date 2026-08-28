# ZackCloud Lite（扎克云 Lite）

ZackCloud Lite V0.2 是供少数朋友免费使用的私人订阅整理/分发服务，不是代理服务器。

订阅获取路径：

```text
朋友 → Cloudflare Worker（只获取、整理、返回订阅）→ 获得 Mihomo 配置
```

实际代理流量始终是：

```text
朋友的 Clash / Mihomo → 直接连接原上游节点 → Internet
```

Worker 不承载、不转发、不检查也不保存 VLESS、Hysteria2、Trojan、Shadowsocks 或其他代理流量。

## V0.2 功能

- `GET /health`：无环境信息的健康检查。
- `GET /`：私人服务说明页。
- `GET /sub/:token`：统一返回整理后的 Clash/Mihomo YAML。
- 使用 `clash.meta` User-Agent 获取真实上游提供的完整 Clash YAML。
- 节点只修改 `name`；其余已知和未知连接字段原样保留。
- 识别 15 个常见地区并稳定编号，未识别节点归入“其他”。
- 生成自动选择、手动选择、故障转移以及非空地区代理组。
- 仅透传 `subscription-userinfo`、`profile-update-interval` 两个上游 metadata header。
- 支持旧版 `ALLOWED_TOKENS` 和可选 `FRIENDS_CONFIG_JSON`。
- 上游超时、异常状态、HTML、空响应和未知格式统一返回安全的 `502`。

当前不支持 Base64/URI 或 sing-box 转换。格式探测器可以识别它们，但真实上游使用合适 User-Agent 后会直接提供 Clash YAML，因此 V0.2 没有引入不必要的协议解析器。

## 本地开发

需要 Node.js 20 或更新版本。

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
npm run dev
```

`.dev.vars` 已被 Git 忽略。它只能保存在本机，不要发送、提交或粘贴其中内容。

环境变量：

- `UPSTREAM_SUBSCRIPTION_URL`：真实上游订阅地址，生产环境必须使用 Worker Secret。
- `ALLOWED_TOKENS`：逗号分隔 token，保留用于向后兼容。
- `FRIENDS_CONFIG_JSON`：可选朋友配置。有效朋友需要 `enabled: true`，且 `expiresAt` 为 `null` 或未来的 ISO 时间。

示例文件 [.dev.vars.example](.dev.vars.example) 只包含假值。朋友配置示例：

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

朋友的名称和有效期只用于服务端判断，不会出现在响应中。无效、禁用、过期和未知 token 都统一返回 `404`。

## 测试与检查

```powershell
npm test
npm run typecheck
npm run lint
npm run deploy:dry-run
```

经过授权的本机可以额外运行安全真实集成测试：

```powershell
npm run integration:safe
```

该脚本只输出格式、数量和 PASS/FAIL 聚合信息；不会输出订阅地址、节点、凭据或订阅正文。验证成功后，它会将最后一次转换结果保存到项目外的用户本地数据目录，并尝试设置为仅当前用户可读写。此文件只用于本地人工验证，Worker V0.2 尚未实现运行时缓存或故障容灾。

## Cloudflare Secret 与部署准备

人工确认 Cloudflare 账户后，分别设置需要的 Secret：

```powershell
npx wrangler secret put UPSTREAM_SUBSCRIPTION_URL
npx wrangler secret put ALLOWED_TOKENS
npx wrangler secret put FRIENDS_CONFIG_JSON
```

可以先做不会部署的本地构建：

```powershell
npm run deploy:dry-run
```

只有人工确认后才能执行 `npx wrangler deploy`。本项目开发流程不会自动登录 Cloudflare、创建 Worker、修改 DNS 或执行生产部署。

## 转换和安全边界

转换器位于 `src/converter/`。检测器负责判断输入格式，Clash 转换器负责重命名与代理组生成。地区编号取决于上游节点顺序，因此同一份上游输入的结果唯一、稳定且可预测。

安全措施包括：

- 不记录 token、上游 URL、上游正文或异常内部信息。
- 不向客户端返回上游 URL、原始错误正文或上游网站 header。
- token 限制长度并拒绝控制字符和路径分隔符。
- 订阅、JSON 和首页响应带有基础安全 header。
- `.dev.vars`、`.env`、`node_modules`、`dist` 和 Wrangler 临时文件均被 Git 忽略。
- 不使用数据库、KV、D1、R2、Durable Objects、Redis、Docker 或前端框架。
