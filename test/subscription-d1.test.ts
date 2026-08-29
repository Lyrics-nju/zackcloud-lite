import { beforeAll, describe, expect, it, vi } from "vitest";
import { isTokenAllowed } from "../src/auth";
import { sha256Hex } from "../src/hash";
import { createHandler } from "../src/index";
import { buildSnapshot } from "../src/snapshot";
import type { SubscriptionSnapshot } from "../src/snapshot";
import type { Env } from "../src/types";
import { clashYaml } from "./fixtures";

type AuthRow = { status: string; expires_at: string | null };

function authDb(rows: Map<string, AuthRow>, bound?: string[]): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn((hash: string) => ({
        first: vi.fn(async () => {
          bound?.push(hash);
          return rows.get(hash) ?? null;
        }),
      })),
    })),
  } as unknown as D1Database;
}

let snapshot: SubscriptionSnapshot;
beforeAll(async () => { snapshot = (await buildSnapshot(clashYaml, new Headers())).snapshot; });

describe("D1 subscription authentication", () => {
  it("looks up a SHA-256 token hash and accepts an approved user", async () => {
    const token = "d1-approved-example-token";
    const hash = await sha256Hex(token);
    const observed: string[] = [];
    expect(await isTokenAllowed(token, { AUTH_DB: authDb(new Map([[hash, { status: "APPROVED", expires_at: null }]]), observed) })).toBe(true);
    expect(observed).toEqual([hash]);
    expect(observed[0]).not.toBe(token);
  });

  it.each([
    ["DISABLED", null],
    ["REJECTED", null],
    ["PENDING", null],
    ["APPROVED", "2020-01-01T00:00:00Z"],
  ])("returns 404-equivalent authorization for %s", async (status, expiresAt) => {
    const token = "d1-inactive-example-token";
    const hash = await sha256Hex(token);
    expect(await isTokenAllowed(token, {
      AUTH_DB: authDb(new Map([[hash, { status, expires_at: expiresAt }]])),
    }, Date.parse("2026-01-01T00:00:00Z"))).toBe(false);
  });

  it("invalidates the old token hash after rotation", async () => {
    const oldToken = "d1-old-example-token";
    const newToken = "d1-new-example-token";
    const rows = new Map([[await sha256Hex(newToken), { status: "APPROVED", expires_at: null }]]);
    const env = { AUTH_DB: authDb(rows) };
    expect(await isTokenAllowed(oldToken, env)).toBe(false);
    expect(await isTokenAllowed(newToken, env)).toBe(true);
  });

  it("falls back to legacy FRIENDS_CONFIG_JSON only when D1 has no credential", async () => {
    const env: Env = {
      AUTH_DB: authDb(new Map()),
      FRIENDS_CONFIG_JSON: JSON.stringify([{ token: "legacy-owner-example", enabled: true, expiresAt: null }]),
    };
    expect(await isTokenAllowed("legacy-owner-example", env)).toBe(true);
  });

  it("keeps the existing owner-style legacy token compatible", async () => {
    const env: Env = {
      AUTH_DB: authDb(new Map()),
      FRIENDS_CONFIG_JSON: JSON.stringify([{ token: "owner-staging-example", enabled: true, expiresAt: null }]),
    };
    expect(await isTokenAllowed("owner-staging-example", env)).toBe(true);
  });

  it("does not let a disabled D1 credential escape through legacy fallback", async () => {
    const token = "same-token-example-value";
    const env: Env = {
      AUTH_DB: authDb(new Map([[await sha256Hex(token), { status: "DISABLED", expires_at: null }]])),
      FRIENDS_CONFIG_JSON: JSON.stringify([{ token, enabled: true, expiresAt: null }]),
    };
    expect(await isTokenAllowed(token, env)).toBe(false);
  });

  it("serves the unchanged KV snapshot for a D1-approved token", async () => {
    const token = "d1-worker-example-token";
    const env: Env = {
      AUTH_DB: authDb(new Map([[await sha256Hex(token), { status: "APPROVED", expires_at: null }]])),
      SUBSCRIPTION_STORE: { get: vi.fn().mockResolvedValue(JSON.stringify(snapshot)) } as unknown as KVNamespace,
    };
    const response = await createHandler()(new Request(`https://worker.example.invalid/sub/${token}`), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(snapshot.yaml);
  });
});
