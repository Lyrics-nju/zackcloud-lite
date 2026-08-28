import { beforeAll, describe, expect, it, vi } from "vitest";
import { createHandler } from "../src/index";
import { buildSnapshot, SNAPSHOT_KEY } from "../src/snapshot";
import type { SubscriptionSnapshot } from "../src/snapshot";
import type { Env } from "../src/types";
import { clashYaml } from "./fixtures";

let validSnapshot: SubscriptionSnapshot;

beforeAll(async () => {
  validSnapshot = (await buildSnapshot(clashYaml, new Headers({
    "subscription-userinfo": "upload=1; download=2; total=3; expire=4",
    "profile-update-interval": "24",
    "profile-web-page-url": "https://blocked.example.invalid",
  }))).snapshot;
});

function mockStore(value: string | null, rejects = false): KVNamespace {
  return {
    get: rejects ? vi.fn().mockRejectedValue(new Error("private KV detail")) : vi.fn().mockResolvedValue(value),
  } as unknown as KVNamespace;
}

function envWith(value: string | null = "valid"): Env {
  return {
    ALLOWED_TOKENS: "test-a,test encoded",
    FRIENDS_CONFIG_JSON: JSON.stringify([
      { token: "friend-ok", name: "friend-a", enabled: true, expiresAt: null },
      { token: "friend-off", name: "friend-b", enabled: false, expiresAt: null },
      { token: "friend-old", name: "friend-c", enabled: true, expiresAt: "2000-01-01T00:00:00Z" },
    ]),
    SUBSCRIPTION_STORE: mockStore(value === "valid" ? JSON.stringify(validSnapshot) : value),
  };
}

const request = (path: string, init?: RequestInit) => new Request(`https://worker.example.invalid${path}`, init);

describe("routes and friend access control", () => {
  it("returns versioned health status", async () => {
    const response = await createHandler()(request("/health"), envWith());
    expect(await response.json()).toEqual({ status: "ok", service: "zackcloud-lite", version: "0.3.0" });
  });

  it("serves the private Chinese homepage with security headers", async () => {
    const response = await createHandler()(request("/"), envWith());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("私人订阅整理服务");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it.each(["POST", "PUT", "DELETE"])("rejects %s with 405", async (method) => {
    expect((await createHandler()(request("/sub/test-a", { method }), envWith())).status).toBe(405);
  });

  it.each(["/sub/", "/unknown", "/sub/a/b", "/sub/%E0%A4%A"])("returns 404 for unsafe path %s", async (path) => {
    expect((await createHandler()(request(path), envWith())).status).toBe(404);
  });

  it.each(["unknown", "friend-off", "friend-old"])("returns indistinguishable 404 for token state", async (token) => {
    expect((await createHandler()(request(`/sub/${token}`), envWith())).status).toBe(404);
  });

  it("returns 404 for malformed friend JSON", async () => {
    expect((await createHandler()(request("/sub/friend-ok"), { ...envWith(), FRIENDS_CONFIG_JSON: "{" })).status).toBe(404);
  });

  it("accepts an enabled friend token", async () => {
    expect((await createHandler()(request("/sub/friend-ok"), envWith())).status).toBe(200);
  });

  it("keeps legacy ALLOWED_TOKENS compatible", async () => {
    expect((await createHandler()(request("/sub/test-a"), envWith())).status).toBe(200);
  });

  it("accepts a URL-encoded token", async () => {
    expect((await createHandler()(request("/sub/test%20encoded"), envWith())).status).toBe(200);
  });

  it("rejects oversized tokens", async () => {
    expect((await createHandler()(request(`/sub/${"x".repeat(513)}`), envWith())).status).toBe(404);
  });

  it("does not read KV for an invalid token", async () => {
    const env = envWith();
    await createHandler()(request("/sub/unknown"), env);
    expect(env.SUBSCRIPTION_STORE?.get).not.toHaveBeenCalled();
  });
});

describe("KV snapshot subscription delivery", () => {
  it("reads only subscription:current", async () => {
    const env = envWith();
    await createHandler()(request("/sub/test-a"), env);
    expect(env.SUBSCRIPTION_STORE?.get).toHaveBeenCalledWith(SNAPSHOT_KEY);
  });

  it("does not call fetch during subscription delivery", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      expect((await createHandler()(request("/sub/test-a"), envWith())).status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not require UPSTREAM_SUBSCRIPTION_URL", async () => {
    expect((await createHandler()(request("/sub/test-a"), envWith())).status).toBe(200);
  });

  it("returns 503 when the KV binding is missing", async () => {
    const response = await createHandler()(request("/sub/test-a"), { ALLOWED_TOKENS: "test-a" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "subscription_temporarily_unavailable" });
  });

  it("returns 503 when current is missing", async () => {
    expect((await createHandler()(request("/sub/test-a"), envWith(null))).status).toBe(503);
  });

  it("returns 503 when KV read fails", async () => {
    const env = envWith();
    env.SUBSCRIPTION_STORE = mockStore(null, true);
    const response = await createHandler()(request("/sub/test-a"), env);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private KV detail");
  });

  it.each(["not json", "{}", JSON.stringify({ schemaVersion: 999 })])("returns 503 for invalid snapshot JSON", async (value) => {
    expect((await createHandler()(request("/sub/test-a"), envWith(value))).status).toBe(503);
  });

  it("returns 503 for empty YAML", async () => {
    const snapshot = { ...validSnapshot, yaml: "" };
    expect((await createHandler()(request("/sub/test-a"), envWith(JSON.stringify(snapshot)))).status).toBe(503);
  });

  it("returns 503 for an invalid hash format", async () => {
    const snapshot = { ...validSnapshot, sha256: "not-a-hash" };
    expect((await createHandler()(request("/sub/test-a"), envWith(JSON.stringify(snapshot)))).status).toBe(503);
  });

  it("returns 503 when YAML does not match the valid hash", async () => {
    const snapshot = { ...validSnapshot, yaml: `${validSnapshot.yaml}\n# changed` };
    expect((await createHandler()(request("/sub/test-a"), envWith(JSON.stringify(snapshot)))).status).toBe(503);
  });

  it("returns valid YAML with private revalidation headers", async () => {
    const response = await createHandler()(request("/sub/test-a"), envWith());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(validSnapshot.yaml);
    expect(response.headers.get("content-type")).toContain("application/yaml");
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("sets a strong ETag from the snapshot hash", async () => {
    const response = await createHandler()(request("/sub/test-a"), envWith());
    expect(response.headers.get("etag")).toBe(`"${validSnapshot.sha256}"`);
  });

  it("returns 304 for a matching If-None-Match", async () => {
    const response = await createHandler()(request("/sub/test-a", {
      headers: { "if-none-match": `"${validSnapshot.sha256}"` },
    }), envWith());
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
  });

  it("returns 200 for a non-matching If-None-Match", async () => {
    const response = await createHandler()(request("/sub/test-a", { headers: { "if-none-match": '"different"' } }), envWith());
    expect(response.status).toBe(200);
  });

  it("forwards only snapshot metadata whitelist", async () => {
    const response = await createHandler()(request("/sub/test-a"), envWith());
    expect(response.headers.get("subscription-userinfo")).toBe("upload=1; download=2; total=3; expire=4");
    expect(response.headers.get("profile-update-interval")).toBe("24");
    expect(response.headers.get("profile-web-page-url")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
