# ZackCloud Lite V0.3 设计

## 目标

把上游获取与朋友下载彻底解耦。Updater 在受控环境获取、转换并验证上游，成功后发布不可变语义的 snapshot；Worker 只认证朋友并读取 KV 中的最后一次成功结果。Worker 的订阅路由不持有或访问上游地址。

```text
更新：Updater → upstream → converter → validator → KV current
下载：Client → Worker → token auth → KV current
代理：Client → 原上游 proxy node → Internet
```

## 借鉴范围

设计受到成熟订阅管理器中 source/output 分离、处理 pipeline、最终下载链接、metadata 白名单和备份思想启发，包括 Sub-Store、subconverter、sub-store-cloudflare 与 Hiddify Manager。这里只借鉴公开架构思想；实现为本项目独立代码，不复制 GPL/AGPL 源码。

## Snapshot

KV binding 为 `SUBSCRIPTION_STORE`，V0.3 只使用 `subscription:current`。JSON 包含 schema 版本、生成时间、最终 YAML 的 SHA-256、代理数量、YAML 和安全 metadata。

发布前必须通过：YAML 解析、代理数量大于零、所有节点删除 `name` 后 deepEqual、名称唯一、代理组引用完整、metadata 白名单和 snapshot hash 验证。全部完成后只执行一次 current 覆盖；任何失败都不会调用 KV write，因此旧 current 保持可用。考虑到当前只有一个写入者，单 key 比 current/previous 多步更新更简单，也避免 KV 最终一致性下的伪事务。

## 安全与故障隔离

- 上游请求限制 10 秒和 5 MiB，只接受预配置的 Secret URL。
- Publisher 只打印聚合统计和安全原因枚举，不打印 URL、正文、节点或完整 hash。
- Worker 对缺失 binding、缺失 key、损坏 JSON、不支持 schema、空 YAML和 hash 不匹配统一返回 503，绝不实时回源。
- 只存储和透传 `subscription-userinfo` 与 `profile-update-interval`。
- ETag 使用带引号的 snapshot SHA-256；匹配 `If-None-Match` 时返回 304。
- 订阅响应使用 `private, no-cache`，避免共享缓存跨 token 混用，同时允许客户端重验证。

## 自动与手动更新

GitHub Actions 每 6 小时及手动触发，使用临时文件并在结束前删除。如果 GitHub runner 被上游拒绝，任务输出安全诊断、失败退出且不写 KV。本地 WSL publisher 使用同一 pipeline，可作为可靠的人工更新后备；开发者电脑关闭后，朋友仍从 Cloudflare KV 获取 last-known-good snapshot。
