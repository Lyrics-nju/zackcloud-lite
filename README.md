# ZackCloud Lite（扎克云 Lite）

一个供少数朋友免费使用的私人订阅整理/分发服务。Worker 只拉取和转换订阅，不承载、转发或记录代理流量。

真实连接路径始终是：

```text
朋友的 Clash / Mihomo → 原上游机场节点 → Internet
```

## V0.1 能力

- `GET /health`：健康检查。
- `GET /`：中文说明首页。
- `GET /sub/:token`：验证 token，获取上游 Clash/Mihomo YAML，重命名节点并生成代理组。
- 使用 `UPSTREAM_SUBSCRIPTION_URL` 和 `ALLOWED_TOKENS` 环境绑定；代码与配置文件不保存真实值。
- 上游请求 10 秒超时；上游或格式错误返回不含内部细节的 `502`。

V0.1 只识别结构明确、含非空 `proxies` 且每个节点至少具有 `name`、`type`、`server` 的 Clash/Mihomo YAML。Base64/V2Ray、数据库、用户管理、用量统计和代理中转均未实现。

## 本地开发

需要 Node.js 20 或更新版本。

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Windows PowerShell 可使用：

```powershell
Copy-Item .dev.vars.example .dev.vars
npm run dev
```

`.dev.vars` 已被 Git 忽略。请只在本机填入真实上游 URL，并为本地开发使用测试 token。

## 检查与测试

```bash
npm test
npm run typecheck
npm run lint
npm run deploy:dry-run
```

最后一条只执行本地构建检查，不会部署。

## Cloudflare 配置与部署

先在 Cloudflare 中为 Worker 设置 Secret，不要把值写进 `wrangler.jsonc`、源码或 Git：

```bash
npx wrangler secret put UPSTREAM_SUBSCRIPTION_URL
npx wrangler secret put ALLOWED_TOKENS
```

人工确认目标账户和 Secret 后，才可执行：

```bash
npx wrangler deploy
```

本项目不会自动执行生产部署，也不要求在开发阶段登录 Cloudflare。

## 转换规则

转换器位于 `src/converter/`。入口按顺序探测支持的格式，当前只注册 Clash YAML 转换器；以后可以添加 Base64/V2Ray 转换器而无需更改路由。

节点按上游原顺序扫描，根据原名识别香港、日本、新加坡、美国、台湾、韩国；同地区编号由该顺序稳定生成，无法识别的节点归为“其他”。除 `name` 外，节点字段会原样保留。原有 `proxy-groups` 会被四个扎克云代理组替换，其他顶层配置保留。

## 安全边界

- 不记录请求 token、上游 URL 或上游响应。
- 不向客户端返回上游 URL、响应正文或内部错误信息。
- 不提供 VLESS/Xray/Mihomo 流量中转能力。
- 不在仓库保存 `.dev.vars`、`.env`、密钥、凭据或真实订阅内容。
