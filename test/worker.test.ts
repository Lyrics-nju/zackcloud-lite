import { afterEach, describe, expect, it, vi } from "vitest";
import { createHandler } from "../src/index";
import type { Env } from "../src/types";
import { clashYaml } from "./fixtures";

const env: Env = {
  ALLOWED_TOKENS: "test-a,test encoded",
  UPSTREAM_SUBSCRIPTION_URL: "https://upstream.example.invalid/sub",
  FRIENDS_CONFIG_JSON: JSON.stringify([
    { token: "friend-ok", name: "friend-a", enabled: true, expiresAt: null },
    { token: "friend-off", name: "friend-b", enabled: false, expiresAt: null },
    { token: "friend-old", name: "friend-c", enabled: true, expiresAt: "2000-01-01T00:00:00Z" },
  ]),
};

const request = (path: string, method = "GET") => new Request(`https://worker.example.invalid${path}`, { method });
const yamlResponse = (headers?: HeadersInit) => new Response(clashYaml, { headers });

afterEach(() => vi.useRealTimers());

describe("routes and access control", () => {
  it("returns health status", async () => {
    const response = await createHandler()(request("/health"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "zackcloud-lite" });
  });

  it("serves the Chinese homepage with security headers", async () => {
    const response = await createHandler()(request("/"), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("私人订阅整理服务");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("rejects non-GET methods with 405", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await createHandler()(request("/sub/test-a", method), env)).status).toBe(405);
    }
  });

  it("returns 404 for a missing token", async () => {
    expect((await createHandler()(request("/sub/"), env)).status).toBe(404);
  });

  it("returns 404 for an invalid token without fetching", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect((await createHandler(fetcher)(request("/sub/nope"), env)).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns 404 for a disabled friend", async () => {
    expect((await createHandler()(request("/sub/friend-off"), env)).status).toBe(404);
  });

  it("returns 404 for an expired friend", async () => {
    expect((await createHandler()(request("/sub/friend-old"), env)).status).toBe(404);
  });

  it("accepts an enabled friend", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(yamlResponse());
    expect((await createHandler(fetcher)(request("/sub/friend-ok"), env)).status).toBe(200);
  });

  it("keeps ALLOWED_TOKENS backward compatible", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(yamlResponse());
    expect((await createHandler(fetcher)(request("/sub/test-a"), env)).status).toBe(200);
  });

  it("accepts a URL-encoded token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(yamlResponse());
    expect((await createHandler(fetcher)(request("/sub/test%20encoded"), env)).status).toBe(200);
  });

  it("safely rejects malformed encoding and oversized tokens", async () => {
    expect((await createHandler()(request("/sub/%E0%A4%A"), env)).status).toBe(404);
    expect((await createHandler()(request(`/sub/${"x".repeat(513)}`), env)).status).toBe(404);
  });
});

describe("upstream resilience and privacy", () => {
  it("uses the selected User-Agent and Accept header", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(yamlResponse());
    await createHandler(fetcher)(request("/sub/test-a"), env);
    const init = fetcher.mock.calls[0][1];
    expect(new Headers(init?.headers).get("user-agent")).toBe("clash.meta");
    expect(new Headers(init?.headers).get("accept")).toContain("application/yaml");
  });

  it("maps upstream 500 to a safe 502", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("sensitive upstream detail", { status: 500 }));
    const response = await createHandler(fetcher)(request("/sub/test-a"), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "upstream_unavailable" });
    expect(response.headers.get("x-zackcloud-upstream-diagnostic")).toBeNull();
  });

  it("aborts a timed-out upstream request", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = createHandler(fetcher)(request("/sub/test-a"), env);
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "upstream_unavailable" });
  });

  it("classifies an empty upstream response without exposing the reason by default", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("   "));
    const response = await createHandler(fetcher)(request("/sub/test-a"), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "upstream_unavailable" });
    expect(response.headers.get("x-zackcloud-upstream-diagnostic")).toBeNull();
  });

  it.each(["<html>not a subscription</html>", "random garbage"])("rejects unsupported content safely", async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const response = await createHandler(fetcher)(request("/sub/test-a"), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "unsupported_subscription_format" });
  });

  it("does not leak the upstream URL or token in an error", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("network failed"));
    const response = await createHandler(fetcher)(request("/sub/test-a"), env);
    const body = await response.text();
    expect(body).not.toContain(env.UPSTREAM_SUBSCRIPTION_URL);
    expect(body).not.toContain("test-a");
  });

  it.each([
    [403, "http_403"],
    [404, "http_404"],
    [429, "http_429"],
    [503, "http_5xx"],
  ])("exposes only safe reason %s in staging diagnostics", async (status, reason) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("not exposed", { status }));
    const response = await createHandler(fetcher)(request("/sub/test-a"), { ...env, STAGING_DIAGNOSTICS: "1" });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "upstream_unavailable" });
    expect(response.headers.get("x-zackcloud-upstream-diagnostic")).toBe(reason);
    expect(response.headers.get("x-zackcloud-upstream-diagnostic")).not.toContain("http://");
  });

  it("reports network_error safely in staging diagnostics", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("private host detail"));
    const response = await createHandler(fetcher)(request("/sub/test-a"), { ...env, STAGING_DIAGNOSTICS: "1" });
    expect(response.headers.get("x-zackcloud-upstream-diagnostic")).toBe("network_error");
    expect(await response.json()).toEqual({ error: "upstream_unavailable" });
  });

  it("forwards only whitelisted subscription metadata", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(yamlResponse({
      "subscription-userinfo": "upload=1; download=2; total=3; expire=4",
      "profile-update-interval": "24",
      "profile-web-page-url": "https://sensitive.example.invalid",
      "set-cookie": "private=fake",
      "content-disposition": "attachment; filename=sensitive-name.yaml",
    }));
    const response = await createHandler(fetcher)(request("/sub/test-a"), env);
    expect(response.headers.get("subscription-userinfo")).toBe("upload=1; download=2; total=3; expire=4");
    expect(response.headers.get("profile-update-interval")).toBe("24");
    expect(response.headers.get("profile-web-page-url")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-disposition")).toBe("inline; filename=zackcloud-lite.yaml");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
