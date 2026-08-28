import { convertSubscription, UnsupportedSubscriptionError } from "./converter";
import { fetchUpstream, UpstreamError } from "./upstream";
import type { Env, Fetcher } from "./types";

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZackCloud Lite · 扎克云 Lite</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;font-family:ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif;background:radial-gradient(circle at 20% 10%,#183a59 0,transparent 35%),linear-gradient(145deg,#07111d,#0b1728 55%,#101b30);color:#eaf2ff}.card{width:min(680px,100%);padding:52px;border:1px solid #ffffff1c;border-radius:28px;background:#ffffff0b;box-shadow:0 28px 90px #0008;backdrop-filter:blur(16px)}.mark{display:inline-grid;place-items:center;width:52px;height:52px;border-radius:16px;background:linear-gradient(135deg,#5eead4,#60a5fa);color:#07111d;font-size:26px;font-weight:900}h1{margin:24px 0 10px;font-size:clamp(36px,8vw,66px);letter-spacing:-.05em}h1 span{color:#7dd3fc}p{max-width:540px;margin:0;color:#b9c8da;font-size:18px;line-height:1.8}.note{margin-top:34px;padding-top:22px;border-top:1px solid #ffffff18;color:#7890a9;font-size:14px}
</style></head><body><main class="card"><div class="mark">Z</div><h1>扎克云 <span>Lite</span></h1><p>为少数朋友准备的私人订阅整理服务。它只负责获取、整理并分发订阅配置；连接仍由你的 Clash / Mihomo 客户端直接建立到原上游节点。</p><div class="note">私人使用 · 无商业销售 · 不承载代理流量</div></main></body></html>`;

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

function allowedTokens(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((token) => token.trim()).filter(Boolean));
}

export function createHandler(fetcher: Fetcher = fetch) {
  return async (request: Request, env: Env): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    if (url.pathname === "/health") return json({ status: "ok", service: "zackcloud-lite" });
    if (url.pathname === "/") return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });

    const match = /^\/sub\/([^/]+)$/.exec(url.pathname);
    if (!match) return json({ error: "not_found" }, 404);

    let token: string;
    try { token = decodeURIComponent(match[1]); } catch { return json({ error: "not_found" }, 404); }
    if (!allowedTokens(env.ALLOWED_TOKENS).has(token)) return json({ error: "not_found" }, 404);

    try {
      const upstream = await fetchUpstream(env.UPSTREAM_SUBSCRIPTION_URL, fetcher);
      const output = convertSubscription(await upstream.text(), upstream.headers.get("content-type"));
      return new Response(output, {
        headers: {
          "content-type": "application/yaml; charset=utf-8",
          "content-disposition": "inline; filename=zackcloud-lite.yaml",
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      if (error instanceof UpstreamError) return json({ error: "upstream_unavailable" }, 502);
      if (error instanceof UnsupportedSubscriptionError) return json({ error: "unsupported_subscription_format" }, 502);
      return json({ error: "subscription_processing_failed" }, 502);
    }
  };
}

export default { fetch: createHandler() } satisfies ExportedHandler<Env>;
