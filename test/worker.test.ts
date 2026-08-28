import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { createHandler } from "../src/index";
import type { Env } from "../src/types";

const env: Env = {
  ALLOWED_TOKENS: "test-a,test-b",
  UPSTREAM_SUBSCRIPTION_URL: "https://example.invalid/sub",
};

const yaml = `mixed-port: 7890
proxies:
  - name: Hong Kong Premium
    type: ss
    server: hk.example.invalid
    port: 443
    cipher: aes-128-gcm
  - name: Tokyo 2
    type: trojan
    server: jp.example.invalid
    port: 443
    sni: edge.example.invalid
  - name: HK Backup
    type: vmess
    server: backup.example.invalid
    port: 8443
    alterId: 0
`;

describe("ZackCloud Lite Worker", () => {
  it("returns health status", async () => {
    const response = await createHandler()(new Request("https://worker.invalid/health"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "zackcloud-lite" });
  });

  it("returns 404 for an invalid token without fetching upstream", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await createHandler(fetcher)(new Request("https://worker.invalid/sub/nope"), env);
    expect(response.status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fetches and converts YAML for an allowed token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(yaml, { status: 200 }));
    const response = await createHandler(fetcher)(new Request("https://worker.invalid/sub/test-a"), env);
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();

    const output = parse(await response.text());
    expect(output.proxies.map((proxy: { name: string }) => proxy.name)).toEqual([
      "🇭🇰 扎克云 · 香港 01", "🇯🇵 扎克云 · 日本 01", "🇭🇰 扎克云 · 香港 02",
    ]);
    expect(output["proxy-groups"].map((group: { name: string }) => group.name)).toEqual([
      "🚀 扎克云 · 自动选择", "👆 扎克云 · 手动选择", "🇭🇰 香港优先", "🇯🇵 日本优先",
    ]);
  });

  it("preserves connection fields while renaming", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(yaml));
    const response = await createHandler(fetcher)(new Request("https://worker.invalid/sub/test-b"), env);
    const output = parse(await response.text());
    expect(output.proxies[0]).toMatchObject({ type: "ss", server: "hk.example.invalid", port: 443, cipher: "aes-128-gcm" });
    expect(output.proxies[1]).toMatchObject({ type: "trojan", server: "jp.example.invalid", port: 443, sni: "edge.example.invalid" });
    expect(output.proxies[2]).toMatchObject({ type: "vmess", server: "backup.example.invalid", port: 8443, alterId: 0 });
  });

  it("maps an upstream 500 to 502 without leaking its URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("internal detail", { status: 500 }));
    const response = await createHandler(fetcher)(new Request("https://worker.invalid/sub/test-a"), env);
    const body = await response.text();
    expect(response.status).toBe(502);
    expect(body).not.toContain(env.UPSTREAM_SUBSCRIPTION_URL);
    expect(body).not.toContain("internal detail");
  });

  it("rejects unrecognized subscription content clearly", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("not a supported subscription"));
    const response = await createHandler(fetcher)(new Request("https://worker.invalid/sub/test-a"), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "unsupported_subscription_format" });
  });
});
