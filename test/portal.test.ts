import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPortalHandler } from "../portal/src/index";
import type { NewUser, PortalRepository } from "../portal/src/repository";
import {
  createPortablePasswordHash,
  decryptToken,
  encryptToken,
  hashPassword,
  PASSWORD_ITERATIONS,
  randomOpaqueToken,
  sha256,
  verifyPassword,
  verifyPortablePassword,
} from "../portal/src/security";
import type {
  AuditRecord,
  CredentialRecord,
  PortalEnv,
  SessionRecord,
  StatusCounts,
  UserRecord,
  UserStatus,
} from "../portal/src/types";

const ORIGIN = "https://portal.example.invalid";
const PASSWORD = "example-password-safe";
const CSRF = "example-csrf-value-safe";
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NOW = Date.parse("2026-08-29T00:00:00Z");
let passwordData: Awaited<ReturnType<typeof hashPassword>>;
let adminHash: string;

class MemoryPortalRepository implements PortalRepository {
  users = new Map<string, UserRecord>();
  credentials = new Map<string, CredentialRecord>();
  sessions = new Map<string, SessionRecord>();
  audits: AuditRecord[] = [];

  async createUser(user: NewUser): Promise<void> {
    if ([...this.users.values()].some((entry) => entry.username.toLowerCase() === user.username.toLowerCase())) throw new Error("duplicate");
    this.users.set(user.id, {
      id: user.id, username: user.username, displayName: user.displayName,
      passwordHash: user.passwordHash, passwordSalt: user.passwordSalt,
      passwordIterations: user.passwordIterations, status: "PENDING",
      createdAt: user.now, updatedAt: user.now, approvedAt: null, expiresAt: null,
    });
  }
  async findUserByUsername(username: string) { return [...this.users.values()].find((user) => user.username === username) ?? null; }
  async getUser(id: string) { return this.users.get(id) ?? null; }
  async listUsers() { return [...this.users.values()]; }
  async statusCounts(): Promise<StatusCounts> {
    const users = [...this.users.values()];
    return {
      pending: users.filter((user) => user.status === "PENDING").length,
      approved: users.filter((user) => user.status === "APPROVED").length,
      disabled: users.filter((user) => user.status === "DISABLED").length,
      total: users.length,
    };
  }
  async createSession(session: SessionRecord) { this.sessions.set(session.sessionHash, session); }
  async getSession(hash: string) { return this.sessions.get(hash) ?? null; }
  async deleteSession(hash: string) { this.sessions.delete(hash); }
  async getCredential(userId: string) { return this.credentials.get(userId) ?? null; }
  async approveUser(userId: string, credential: CredentialRecord, actor: string, now: string) {
    const user = this.required(userId);
    this.users.set(userId, { ...user, status: "APPROVED", approvedAt: now, updatedAt: now });
    this.credentials.set(userId, credential);
    this.audit(actor, "approve", userId, now);
  }
  async setUserStatus(userId: string, status: UserStatus, actor: string, action: string, now: string) {
    this.users.set(userId, { ...this.required(userId), status, updatedAt: now });
    this.audit(actor, action, userId, now);
  }
  async setUserExpiry(userId: string, expiresAt: string | null, actor: string, now: string) {
    this.users.set(userId, { ...this.required(userId), expiresAt, updatedAt: now });
    this.audit(actor, "expire", userId, now);
  }
  async rotateCredential(userId: string, credential: CredentialRecord, actor: string, now: string) {
    this.credentials.set(userId, credential);
    this.audit(actor, "rotate", userId, now);
  }
  async deleteUser(userId: string, actor: string, now: string) {
    this.audit(actor, "delete", userId, now);
    this.users.delete(userId);
    this.credentials.delete(userId);
  }
  async listAuditLogs() { return this.audits; }
  seed(username: string, status: UserStatus = "PENDING"): UserRecord {
    const user: UserRecord = {
      id: `id-${username}`, username, displayName: username,
      passwordHash: passwordData.hash, passwordSalt: passwordData.salt,
      passwordIterations: passwordData.iterations, status,
      createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
      approvedAt: status === "APPROVED" ? new Date(NOW).toISOString() : null, expiresAt: null,
    };
    this.users.set(user.id, user);
    return user;
  }
  private required(id: string) { const user = this.users.get(id); if (!user) throw new Error("missing"); return user; }
  private audit(actor: string, action: string, userId: string, now: string) {
    this.audits.push({ actor, action, targetUserId: userId, createdAt: now, detail: null });
  }
}

beforeAll(async () => {
  passwordData = await hashPassword(PASSWORD, 100_000);
  adminHash = await createPortablePasswordHash(PASSWORD);
});

let repository: MemoryPortalRepository;
let env: PortalEnv;
let handler: ReturnType<typeof createPortalHandler>;

beforeEach(() => {
  repository = new MemoryPortalRepository();
  env = {
    AUTH_DB: {} as D1Database,
    TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    ADMIN_USERNAME: "admin-example",
    ADMIN_PASSWORD_HASH: adminHash,
    PORTAL_ORIGIN: ORIGIN,
  };
  handler = createPortalHandler({ repositoryFactory: () => repository, now: () => NOW });
});

function request(path: string, init: RequestInit = {}) { return new Request(`${ORIGIN}${path}`, init); }
function post(path: string, fields: Record<string, string>, cookie = `${CSRF_COOKIE()}=${CSRF}`): Request {
  const body = new URLSearchParams({ csrf: CSRF, ...fields });
  return request(path, { method: "POST", headers: { origin: ORIGIN, cookie, "content-type": "application/x-www-form-urlencoded" }, body });
}
function CSRF_COOKIE() { return "zc_csrf"; }

function csrfRegistration(
  headers: Record<string, string>,
  submitted = CSRF,
  cookie = `${CSRF_COOKIE()}=${CSRF}`,
): Request {
  return request("/register", {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ csrf: submitted }),
  });
}

function authCookies(response: Response): { cookie: string; csrf: string } {
  const value = response.headers.get("set-cookie") ?? "";
  const session = /zc_session=([^;,]+)/.exec(value)?.[1];
  const csrf = /zc_csrf=([^;,]+)/.exec(value)?.[1];
  if (!session || !csrf) throw new Error("missing auth cookies");
  return { cookie: `zc_session=${session}; zc_csrf=${csrf}`, csrf };
}

async function userLogin(user: UserRecord): Promise<{ cookie: string; csrf: string }> {
  const response = await handler(post("/login", { username: user.username, password: PASSWORD }), env);
  expect(response.status).toBe(303);
  return authCookies(response);
}

async function adminLogin(): Promise<{ cookie: string; csrf: string }> {
  const response = await handler(post("/admin/login", { username: "admin-example", password: PASSWORD }), env);
  expect(response.status).toBe(303);
  return authCookies(response);
}

function authenticatedPost(path: string, auth: { cookie: string; csrf: string }, fields: Record<string, string> = {}): Request {
  const body = new URLSearchParams({ csrf: auth.csrf, ...fields });
  return request(path, { method: "POST", headers: { origin: ORIGIN, cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" }, body });
}

describe("registration and password security", () => {
  it("registers a pending user", async () => {
    const response = await handler(post("/register", {
      username: "alice", displayName: "Alice", password: PASSWORD, passwordConfirm: PASSWORD,
    }), env);
    expect(response.status).toBe(201);
    expect(await response.text()).toContain("等待管理员审核");
    expect((await repository.findUserByUsername("alice"))?.status).toBe("PENDING");
  });

  it("returns a friendly duplicate username error", async () => {
    repository.seed("alice");
    const response = await handler(post("/register", {
      username: "alice", displayName: "Alice", password: PASSWORD, passwordConfirm: PASSWORD,
    }), env);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("用户名已被使用");
  });

  it("hashes and verifies passwords but rejects a wrong password", async () => {
    const stored = await hashPassword(PASSWORD, 100_000);
    expect(await verifyPassword(PASSWORD, stored.hash, stored.salt, stored.iterations)).toBe(true);
    expect(await verifyPassword("wrong-password-example", stored.hash, stored.salt, stored.iterations)).toBe(false);
  });
});

describe("sessions, CSRF and user dashboard", () => {
  it("creates a hashed session and shows pending dashboard", async () => {
    const user = repository.seed("alice");
    const auth = await userLogin(user);
    expect(repository.sessions.size).toBe(1);
    expect([...repository.sessions.values()][0].sessionHash).not.toContain(auth.cookie);
    const dashboard = await handler(request("/dashboard", { headers: { cookie: auth.cookie } }), env);
    expect(await dashboard.text()).toContain("账号正在等待审核");
  });

  it("expires a session", async () => {
    const user = repository.seed("alice");
    const expiredSessionHash = await sha256("raw-expired");
    repository.sessions.set(expiredSessionHash, {
      sessionHash: expiredSessionHash, principalId: user.id, role: "USER", csrfHash: await sha256(CSRF),
      createdAt: new Date(NOW - 20_000).toISOString(), expiresAt: new Date(NOW - 1_000).toISOString(),
    });
    const dashboard = await handler(request("/dashboard", { headers: { cookie: "zc_session=raw-expired" } }), env);
    expect(dashboard.status).toBe(303);
    expect(repository.sessions.has(expiredSessionHash)).toBe(false);
  });

  it("revokes a session on logout", async () => {
    const auth = await userLogin(repository.seed("alice"));
    const response = await handler(authenticatedPost("/logout", auth), env);
    expect(response.status).toBe(303);
    expect(repository.sessions.size).toBe(0);
  });

  it("accepts the configured Portal Origin with a matching CSRF token", async () => {
    expect((await handler(csrfRegistration({ origin: ORIGIN }), env)).status).toBe(400);
  });

  it("rejects a foreign Origin", async () => {
    expect((await handler(csrfRegistration({ origin: "https://foreign.example.invalid" }), env)).status).toBe(403);
  });

  it("accepts a null Origin only for a same-origin navigation with matching CSRF", async () => {
    const response = await handler(csrfRegistration({
      origin: "null",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "navigate",
    }), env);
    expect(response.status).toBe(400);
  });

  it("rejects a null Origin from a cross-site navigation", async () => {
    const response = await handler(csrfRegistration({
      origin: "null",
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
    }), env);
    expect(response.status).toBe(403);
  });

  it("rejects a null Origin for a non-navigation request", async () => {
    const response = await handler(csrfRegistration({
      origin: "null",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
    }), env);
    expect(response.status).toBe(403);
  });

  it("rejects a null Origin when Sec-Fetch metadata is missing", async () => {
    expect((await handler(csrfRegistration({ origin: "null" }), env)).status).toBe(403);
  });

  it("rejects a missing Origin even with same-origin navigation metadata", async () => {
    const response = await handler(csrfRegistration({
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "navigate",
    }), env);
    expect(response.status).toBe(403);
  });

  it("rejects mismatched CSRF form and cookie tokens", async () => {
    const response = await handler(csrfRegistration({ origin: ORIGIN }, "different-csrf-value-safe"), env);
    expect(response.status).toBe(403);
  });

  it("keeps session CSRF hash validation after request-level checks pass", async () => {
    const user = repository.seed("alice");
    const auth = await userLogin(user);
    const matchingButUnboundCsrf = "matching-but-unbound-csrf";
    const body = new URLSearchParams({ csrf: matchingButUnboundCsrf });
    const response = await handler(request("/logout", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        cookie: `${auth.cookie.split("; ")[0]}; zc_csrf=${matchingButUnboundCsrf}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    }), env);
    expect(response.status).toBe(403);
    expect(repository.sessions.size).toBe(1);
  });

  it.each([
    ["PENDING", "账号正在等待审核"],
    ["REJECTED", "申请未通过"],
    ["DISABLED", "账号当前已停用"],
  ] as const)("shows %s user state without a credential", async (status, text) => {
    const user = repository.seed("alice", status);
    const auth = await userLogin(user);
    const response = await handler(request("/dashboard", { headers: { cookie: auth.cookie } }), env);
    expect(await response.text()).toContain(text);
    expect((await handler(request("/api/subscription", { headers: { cookie: auth.cookie } }), env)).status).toBe(404);
  });

  it("hides an approved token from static HTML and returns it only through authenticated API", async () => {
    const user = repository.seed("alice", "APPROVED");
    const raw = randomOpaqueToken();
    const encrypted = await encryptToken(raw, ENCRYPTION_KEY);
    repository.credentials.set(user.id, {
      userId: user.id, tokenHash: await sha256(raw), tokenCiphertext: encrypted.ciphertext,
      tokenIv: encrypted.iv, createdAt: new Date(NOW).toISOString(), rotatedAt: null,
    });
    const auth = await userLogin(user);
    const dashboard = await handler(request("/dashboard", { headers: { cookie: auth.cookie } }), env);
    expect(await dashboard.text()).not.toContain(raw);
    const api = await handler(request("/api/subscription", { headers: { cookie: auth.cookie } }), env);
    expect(api.status).toBe(200);
    expect((await api.json() as { url: string }).url).toContain(raw);
  });
});

describe("administrator workflow", () => {
  it("skips password derivation for unknown users and mismatched admin usernames", async () => {
    const deriveBits = vi.spyOn(crypto.subtle, "deriveBits");
    try {
      expect((await handler(post("/login", { username: "missing-user", password: PASSWORD }), env)).status).toBe(401);
      expect((await handler(post("/admin/login", { username: "missing-admin", password: PASSWORD }), env)).status).toBe(401);
      expect(deriveBits).not.toHaveBeenCalled();
    } finally {
      deriveBits.mockRestore();
    }
  });

  it("rejects invalid admin login and accepts configured credentials", async () => {
    expect((await handler(post("/admin/login", { username: "admin-example", password: "wrong-password-example" }), env)).status).toBe(401);
    expect((await handler(post("/admin/login", { username: "admin-example", password: PASSWORD }), env)).status).toBe(303);
  });

  it("approves atomically and writes an audit log", async () => {
    const user = repository.seed("alice");
    const auth = await adminLogin();
    expect((await handler(authenticatedPost(`/admin/users/${user.id}/approve`, auth), env)).status).toBe(303);
    expect(repository.users.get(user.id)?.status).toBe("APPROVED");
    expect(repository.credentials.has(user.id)).toBe(true);
    expect(repository.audits.at(-1)?.action).toBe("approve");
  });

  it.each([
    ["reject", "REJECTED"], ["disable", "DISABLED"], ["enable", "APPROVED"],
  ] as const)("handles admin %s", async (action, status) => {
    const user = repository.seed("alice", action === "enable" ? "DISABLED" : "APPROVED");
    const auth = await adminLogin();
    expect((await handler(authenticatedPost(`/admin/users/${user.id}/${action}`, auth), env)).status).toBe(303);
    expect(repository.users.get(user.id)?.status).toBe(status);
    expect(repository.audits.at(-1)?.action).toBe(action);
  });

  it("updates expiry", async () => {
    const user = repository.seed("alice", "APPROVED");
    const auth = await adminLogin();
    const expiry = "2027-01-01T00:00:00Z";
    expect((await handler(authenticatedPost(`/admin/users/${user.id}/expire`, auth, { expiresAt: expiry }), env)).status).toBe(303);
    expect(repository.users.get(user.id)?.expiresAt).toBe(expiry);
  });

  it("rotates credentials and invalidates the old hash", async () => {
    const user = repository.seed("alice", "APPROVED");
    const oldHash = await sha256("old-example-token-value");
    repository.credentials.set(user.id, {
      userId: user.id, tokenHash: oldHash, tokenCiphertext: "old", tokenIv: "old",
      createdAt: new Date(NOW).toISOString(), rotatedAt: null,
    });
    const auth = await adminLogin();
    expect((await handler(authenticatedPost(`/admin/users/${user.id}/rotate`, auth), env)).status).toBe(303);
    expect(repository.credentials.get(user.id)?.tokenHash).not.toBe(oldHash);
    expect(repository.audits.at(-1)?.action).toBe("rotate");
  });

  it("requires confirmation and deletes a user with an audit record", async () => {
    const user = repository.seed("alice", "APPROVED");
    const auth = await adminLogin();
    expect((await handler(authenticatedPost(`/admin/users/${user.id}/delete`, auth), env)).status).toBe(400);
    expect((await handler(authenticatedPost(`/admin/users/${user.id}/delete`, auth, { confirm: "yes" }), env)).status).toBe(303);
    expect(repository.users.has(user.id)).toBe(false);
    expect(repository.audits.at(-1)?.action).toBe("delete");
  });

  it("renders overview, empty states and destructive confirmation UI", async () => {
    const auth = await adminLogin();
    const response = await handler(request("/admin", { headers: { cookie: auth.cookie } }), env);
    const html = await response.text();
    expect(html).toContain("待审核");
    expect(html).toContain("暂无记录");
    expect(html).toContain("data-confirm-dialog");
  });
});

describe("token encryption and security headers", () => {
  it("derives and verifies runtime-native PBKDF2-SHA256 passwords", async () => {
    const password = await hashPassword(PASSWORD);
    expect(password.iterations).toBe(20_000);
    expect(password.iterations).toBe(PASSWORD_ITERATIONS);
    expect(await verifyPassword(PASSWORD, password.hash, password.salt, password.iterations)).toBe(true);
    expect(await verifyPassword("wrong-password-example", password.hash, password.salt, password.iterations)).toBe(false);
  });

  it("preserves the portable admin hash format and verification", async () => {
    const portable = await createPortablePasswordHash(PASSWORD);
    const [algorithm, iterations, salt, hash] = portable.split("$");
    expect(algorithm).toBe("pbkdf2-sha256");
    expect(iterations).toBe(String(PASSWORD_ITERATIONS));
    expect(salt).toBeTruthy();
    expect(hash).toBeTruthy();
    expect(await verifyPortablePassword(PASSWORD, portable)).toBe(true);
    expect(await verifyPortablePassword("wrong-password-example", portable)).toBe(false);
  });

  it("verifies an existing portable hash derived by the legacy WebCrypto format", async () => {
    const salt = new Uint8Array(16).fill(7);
    const legacyKey = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(PASSWORD), "PBKDF2", false, ["deriveBits"],
    );
    const legacyDerived = new Uint8Array(await crypto.subtle.deriveBits({
      name: "PBKDF2", hash: "SHA-256", salt, iterations: PASSWORD_ITERATIONS,
    }, legacyKey, 256));
    const portable = `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${Buffer.from(salt).toString("base64url")}` +
      `$${Buffer.from(legacyDerived).toString("base64url")}`;
    expect(await verifyPortablePassword(PASSWORD, portable)).toBe(true);
  });

  it("uses the runtime-native WebCrypto PBKDF2 path", () => {
    const source = readFileSync(new URL("../portal/src/security.ts", import.meta.url), "utf8");
    expect(source).toContain("crypto.subtle.deriveBits");
    expect(source).toContain('"PBKDF2"');
    expect(source).not.toContain("@noble/hashes");
    expect(source).not.toContain("pbkdf2Sync");
  });

  it("encrypts and decrypts a token without storing plaintext", async () => {
    const raw = randomOpaqueToken();
    const encrypted = await encryptToken(raw, ENCRYPTION_KEY);
    expect(encrypted.ciphertext).not.toContain(raw);
    expect(await decryptToken(encrypted.ciphertext, encrypted.iv, ENCRYPTION_KEY)).toBe(raw);
    expect(await sha256(raw)).toHaveLength(64);
  });

  it("sets the Portal security header policy", async () => {
    const response = await handler(request("/"), env);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
  });

  it("supports optional invite and Turnstile enforcement", async () => {
    env.REGISTRATION_INVITE_CODE_HASH = await sha256("invite-example");
    env.TURNSTILE_SECRET_KEY = "configured-example";
    handler = createPortalHandler({ repositoryFactory: () => repository, now: () => NOW, verifyTurnstile: async () => false });
    const response = await handler(post("/register", {
      username: "alice", displayName: "Alice", password: PASSWORD, passwordConfirm: PASSWORD,
      inviteCode: "invite-example", "cf-turnstile-response": "failed-example",
    }), env);
    expect(response.status).toBe(403);
  });
});
