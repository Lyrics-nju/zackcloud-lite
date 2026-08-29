import type { Env } from "./types";
import { isTokenAllowed } from "./auth";
import { parseSnapshot, SNAPSHOT_KEY } from "./snapshot";
import type { SnapshotMetadata } from "./snapshot";

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZackCloud Lite · 扎克云 Lite</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;font-family:ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif;background:radial-gradient(circle at 20% 10%,#183a59 0,transparent 35%),linear-gradient(145deg,#07111d,#0b1728 55%,#101b30);color:#eaf2ff}.card{width:min(720px,100%);padding:52px;border:1px solid #ffffff1c;border-radius:28px;background:#ffffff0b;box-shadow:0 28px 90px #0008;backdrop-filter:blur(16px)}.mark{display:inline-grid;place-items:center;width:52px;height:52px;border-radius:16px;background:linear-gradient(135deg,#5eead4,#60a5fa);color:#07111d;font-size:26px;font-weight:900}h1{margin:24px 0 10px;font-size:clamp(36px,8vw,66px);letter-spacing:-.05em}h1 span{color:#7dd3fc}p{max-width:590px;margin:0;color:#b9c8da;font-size:18px;line-height:1.8}.facts{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:30px 0}.facts div{padding:13px;border:1px solid #ffffff17;border-radius:12px;color:#a8c3dc;text-align:center;font-size:14px}.note{margin-top:24px;padding-top:22px;border-top:1px solid #ffffff18;color:#7890a9;font-size:14px}@media(max-width:560px){.card{padding:32px}.facts{grid-template-columns:1fr}}
</style></head><body><main class="card"><div class="mark">Z</div><h1>扎克云 <span>Lite</span></h1><p>为少数朋友准备的私人订阅整理服务。使用专属订阅地址导入 Clash / Mihomo；Worker 只整理配置，实际连接由客户端直接建立到原上游节点。</p><div class="facts"><div>私人使用</div><div>支持 Clash / Mihomo</div><div>不记录代理流量</div></div><div class="note">无注册、无付费、无商业销售 · 请妥善保管自己的订阅地址</div></main></body></html>`;

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

const json = (body: unknown, status = 200, extraHeaders?: HeadersInit): Response => {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS });
  if (extraHeaders) new Headers(extraHeaders).forEach((value, name) => headers.set(name, value));
  return new Response(JSON.stringify(body), { status, headers });
};

function safeSubscriptionHeaders(metadata: SnapshotMetadata, etag: string): Headers {
  const headers = new Headers({
    "content-type": "application/yaml; charset=utf-8",
    "content-disposition": "inline; filename=zackcloud-lite.yaml",
    "cache-control": "private, no-cache",
    etag,
    ...SECURITY_HEADERS,
  });
  for (const name of ["subscription-userinfo", "profile-update-interval"] as const) {
    const value = metadata[name];
    if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

export function createHandler() {
  return async (request: Request, env: Env): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    if (url.pathname === "/health") return json({ status: "ok", service: "zackcloud-lite", version: "0.3.0" });
    if (url.pathname === "/") return new Response(HTML, { headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      ...SECURITY_HEADERS,
    } });

    const match = /^\/sub\/([^/]+)$/.exec(url.pathname);
    if (!match) return json({ error: "not_found" }, 404);

    let token: string;
    try { token = decodeURIComponent(match[1]); } catch { return json({ error: "not_found" }, 404); }
    if (!await isTokenAllowed(token, env)) return json({ error: "not_found" }, 404);

    if (!env.SUBSCRIPTION_STORE) return json({ error: "subscription_temporarily_unavailable" }, 503);
    try {
      const snapshot = await parseSnapshot(await env.SUBSCRIPTION_STORE.get(SNAPSHOT_KEY));
      if (!snapshot) return json({ error: "subscription_temporarily_unavailable" }, 503);
      const etag = `"${snapshot.sha256}"`;
      const headers = safeSubscriptionHeaders(snapshot.metadata, etag);
      if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
      return new Response(snapshot.yaml, { headers });
    } catch {
      return json({ error: "subscription_temporarily_unavailable" }, 503);
    }
  };
}

export default { fetch: createHandler() } satisfies ExportedHandler<Env>;
