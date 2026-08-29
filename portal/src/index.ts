import { friendSubscriptionUrl } from "../../scripts/lib/public-subscription-url";
import { validIsoTimestamp } from "../../scripts/lib/friend-store";
import { D1PortalRepository } from "./repository";
import type { PortalRepository } from "./repository";
import {
  decryptToken,
  encryptToken,
  hashPassword,
  randomOpaqueToken,
  safeId,
  sha256,
  validatePassword,
  verifyPassword,
  verifyPortablePassword,
} from "./security";
import type { CredentialRecord, PortalEnv, SessionRecord, UserRecord } from "./types";
import {
  adminDashboard,
  adminLoginPage,
  homePage,
  loginPage,
  PORTAL_CSS,
  PORTAL_JS,
  registerPage,
  userDashboard,
} from "./ui";

const SESSION_COOKIE = "zc_session";
const CSRF_COOKIE = "zc_csrf";
const DEFAULT_ORIGIN = "https://zackcloud.site";

export interface PortalHandlerOptions {
  repositoryFactory?: (env: PortalEnv) => PortalRepository;
  now?: () => number;
  verifyTurnstile?: (token: string, env: PortalEnv) => Promise<boolean>;
}

function securityHeaders(turnstile = false): Headers {
  const challenge = turnstile ? " https://challenges.cloudflare.com" : "";
  return new Headers({
    "content-security-policy": `default-src 'self'; script-src 'self'${challenge}; style-src 'self'; img-src 'self' data:; connect-src 'self'${challenge}; frame-src${challenge || " 'none'"}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "x-frame-options": "DENY",
    "cache-control": "no-store",
  });
}

function response(body: BodyInit | null, status = 200, type = "text/html; charset=utf-8", turnstile = false): Response {
  const headers = securityHeaders(turnstile);
  headers.set("content-type", type);
  return new Response(body, { status, headers });
}

function json(body: unknown, status = 200): Response {
  return response(JSON.stringify(body), status, "application/json; charset=utf-8");
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = securityHeaders();
  headers.set("location", location);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function cookies(request: Request): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0) result.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return result;
}

function sessionCookie(value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function csrfCookie(value: string, maxAge = 86_400): string {
  return `${CSRF_COOKIE}=${value}; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function clearedCookie(name: string, httpOnly = false): string {
  return `${name}=; ${httpOnly ? "HttpOnly; " : ""}Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function htmlWithCsrf(html: string, csrf: string, turnstile = false): Response {
  const result = response(html, 200, "text/html; charset=utf-8", turnstile);
  result.headers.append("set-cookie", csrfCookie(csrf));
  return result;
}

function originFor(env: PortalEnv): string {
  return env.PORTAL_ORIGIN?.trim() || DEFAULT_ORIGIN;
}

function safeUsername(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9_.-]{3,32}$/.test(normalized) ? normalized : null;
}

function safeDisplayName(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > 50 || [...name].some((character) => character.charCodeAt(0) < 32)) return null;
  return name;
}

async function form(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new Error("FORM_INVALID");
  }
}

async function csrfValid(request: Request, data: FormData, env: PortalEnv, session?: SessionRecord): Promise<boolean> {
  if (request.headers.get("origin") !== originFor(env)) return false;
  const submitted = data.get("csrf");
  const cookie = cookies(request).get(CSRF_COOKIE);
  if (typeof submitted !== "string" || !cookie || submitted.length < 16 || submitted !== cookie) return false;
  return !session || session.csrfHash === await sha256(submitted);
}

async function defaultTurnstile(token: string, env: PortalEnv): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  try {
    const body = new FormData();
    body.set("secret", env.TURNSTILE_SECRET_KEY);
    body.set("response", token);
    const result = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    return Boolean((await result.json() as { success?: boolean }).success);
  } catch {
    return false;
  }
}

async function createSession(
  repository: PortalRepository,
  principalId: string,
  role: "USER" | "ADMIN",
  now: number,
  env: PortalEnv,
): Promise<{ session: string; csrf: string; ttl: number }> {
  const ttl = Math.min(30 * 86_400, Math.max(3_600, Number(env.SESSION_TTL_SECONDS) || 7 * 86_400));
  const session = randomOpaqueToken();
  const csrf = randomOpaqueToken();
  await repository.createSession({
    sessionHash: await sha256(session),
    principalId,
    role,
    csrfHash: await sha256(csrf),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl * 1_000).toISOString(),
  });
  return { session, csrf, ttl };
}

async function authenticatedSession(
  request: Request, repository: PortalRepository, now: number,
): Promise<SessionRecord | null> {
  const raw = cookies(request).get(SESSION_COOKIE);
  if (!raw || raw.length > 512) return null;
  const session = await repository.getSession(await sha256(raw));
  if (!session) return null;
  if (Date.parse(session.expiresAt) <= now) {
    await repository.deleteSession(session.sessionHash);
    return null;
  }
  return session;
}

function credential(userId: string, hash: string, ciphertext: string, iv: string, now: string, rotated = false): CredentialRecord {
  return { userId, tokenHash: hash, tokenCiphertext: ciphertext, tokenIv: iv, createdAt: now, rotatedAt: rotated ? now : null };
}

async function encryptedCredential(userId: string, env: PortalEnv, now: string, rotated = false): Promise<CredentialRecord> {
  if (!env.TOKEN_ENCRYPTION_KEY) throw new Error("TOKEN_ENCRYPTION_KEY_NOT_CONFIGURED");
  const token = randomOpaqueToken();
  const encrypted = await encryptToken(token, env.TOKEN_ENCRYPTION_KEY);
  return credential(userId, await sha256(token), encrypted.ciphertext, encrypted.iv, now, rotated);
}

function activeApproved(user: UserRecord, now: number): boolean {
  return user.status === "APPROVED" && (user.expiresAt === null || Date.parse(user.expiresAt) > now);
}

export function createPortalHandler(options: PortalHandlerOptions = {}) {
  const repositoryFactory = options.repositoryFactory ?? ((env: PortalEnv) => new D1PortalRepository(env.AUTH_DB));
  const clock = options.now ?? Date.now;
  const turnstile = options.verifyTurnstile ?? defaultTurnstile;

  return async (request: Request, env: PortalEnv): Promise<Response> => {
    const url = new URL(request.url);
    const repository = repositoryFactory(env);
    const now = clock();
    const cookieValues = cookies(request);
    const csrf = cookieValues.get(CSRF_COOKIE) ?? randomOpaqueToken();

    try {
      if (request.method === "GET" && url.pathname === "/assets/portal.css") return response(PORTAL_CSS, 200, "text/css; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/assets/portal.js") return response(PORTAL_JS, 200, "text/javascript; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/health") return json({ status: "ok", service: "zackcloud-portal", version: "0.6.0" });
      if (request.method === "GET" && url.pathname === "/") return htmlWithCsrf(homePage(), csrf);
      if (request.method === "GET" && url.pathname === "/register") {
        return htmlWithCsrf(registerPage(csrf, undefined, Boolean(env.REGISTRATION_INVITE_CODE_HASH), env.TURNSTILE_SITE_KEY), csrf, Boolean(env.TURNSTILE_SITE_KEY));
      }
      if (request.method === "POST" && url.pathname === "/register") {
        const data = await form(request);
        if (!await csrfValid(request, data, env)) return response(registerPage(csrf, "错误：请求验证失败"), 403);
        const username = safeUsername(data.get("username"));
        const displayName = safeDisplayName(data.get("displayName"));
        const password = data.get("password");
        const passwordConfirm = data.get("passwordConfirm");
        if (!username || !displayName || typeof password !== "string" || password !== passwordConfirm) {
          return response(registerPage(csrf, "错误：请检查注册信息"), 400);
        }
        try { validatePassword(password); } catch { return response(registerPage(csrf, "错误：密码长度需为 12–128 个字符"), 400); }
        if (env.REGISTRATION_INVITE_CODE_HASH) {
          const invite = data.get("inviteCode");
          if (typeof invite !== "string" || await sha256(invite) !== env.REGISTRATION_INVITE_CODE_HASH) {
            return response(registerPage(csrf, "错误：邀请码无效"), 403);
          }
        }
        const turnstileToken = data.get("cf-turnstile-response");
        if (!await turnstile(typeof turnstileToken === "string" ? turnstileToken : "", env)) {
          return response(registerPage(csrf, "错误：人机验证未通过"), 403);
        }
        if (await repository.findUserByUsername(username)) return response(registerPage(csrf, "错误：该用户名已被使用"), 409);
        const passwordData = await hashPassword(password);
        try {
          await repository.createUser({
            id: safeId(), username, displayName, passwordHash: passwordData.hash,
            passwordSalt: passwordData.salt, passwordIterations: passwordData.iterations,
            now: new Date(now).toISOString(),
          });
        } catch {
          return response(registerPage(csrf, "错误：该用户名已被使用"), 409);
        }
        return response(registerPage(csrf, "申请已提交，等待管理员审核。"), 201);
      }
      if (request.method === "GET" && url.pathname === "/login") return htmlWithCsrf(loginPage(csrf), csrf);
      if (request.method === "POST" && url.pathname === "/login") {
        const data = await form(request);
        if (!await csrfValid(request, data, env)) return response(loginPage(csrf, "错误：请求验证失败"), 403);
        const username = safeUsername(data.get("username"));
        const password = data.get("password");
        const user = username ? await repository.findUserByUsername(username) : null;
        if (!user || typeof password !== "string" ||
            !await verifyPassword(password, user.passwordHash, user.passwordSalt, user.passwordIterations)) {
          return response(loginPage(csrf, "错误：用户名或密码不正确"), 401);
        }
        const created = await createSession(repository, user.id, "USER", now, env);
        return redirect("/dashboard", [sessionCookie(created.session, created.ttl), csrfCookie(created.csrf, created.ttl)]);
      }
      if (request.method === "GET" && url.pathname === "/dashboard") {
        const session = await authenticatedSession(request, repository, now);
        if (!session || session.role !== "USER") return redirect("/login");
        const user = await repository.getUser(session.principalId);
        if (!user) return redirect("/login", [clearedCookie(SESSION_COOKIE, true)]);
        return response(userDashboard(user, csrf));
      }
      if (request.method === "GET" && url.pathname === "/api/subscription") {
        const session = await authenticatedSession(request, repository, now);
        if (!session || session.role !== "USER") return json({ error: "unauthorized" }, 401);
        const user = await repository.getUser(session.principalId);
        if (!user || !activeApproved(user, now)) return json({ error: "not_available" }, 404);
        const stored = await repository.getCredential(user.id);
        if (!stored || !env.TOKEN_ENCRYPTION_KEY) return json({ error: "not_available" }, 404);
        const token = await decryptToken(stored.tokenCiphertext, stored.tokenIv, env.TOKEN_ENCRYPTION_KEY);
        return json({ url: friendSubscriptionUrl(token, {}) });
      }
      if (request.method === "POST" && url.pathname === "/logout") {
        const session = await authenticatedSession(request, repository, now);
        const data = await form(request);
        if (!await csrfValid(request, data, env, session ?? undefined)) return response("Forbidden", 403, "text/plain; charset=utf-8");
        if (session) await repository.deleteSession(session.sessionHash);
        return redirect("/login", [clearedCookie(SESSION_COOKIE, true), clearedCookie(CSRF_COOKIE)]);
      }
      if (request.method === "GET" && url.pathname === "/admin/login") return htmlWithCsrf(adminLoginPage(csrf), csrf);
      if (request.method === "POST" && url.pathname === "/admin/login") {
        const data = await form(request);
        if (!await csrfValid(request, data, env)) return response(adminLoginPage(csrf, "错误：请求验证失败"), 403);
        const username = data.get("username");
        const password = data.get("password");
        if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD_HASH || username !== env.ADMIN_USERNAME ||
            typeof password !== "string" || !await verifyPortablePassword(password, env.ADMIN_PASSWORD_HASH)) {
          return response(adminLoginPage(csrf, "错误：管理员凭据无效"), 401);
        }
        const created = await createSession(repository, env.ADMIN_USERNAME, "ADMIN", now, env);
        return redirect("/admin", [sessionCookie(created.session, created.ttl), csrfCookie(created.csrf, created.ttl)]);
      }
      if (request.method === "GET" && url.pathname === "/admin") {
        const session = await authenticatedSession(request, repository, now);
        if (!session || session.role !== "ADMIN") return redirect("/admin/login");
        return response(adminDashboard(await repository.listUsers(), await repository.statusCounts(), csrf, session.principalId));
      }
      if (request.method === "POST" && url.pathname === "/admin/logout") {
        const session = await authenticatedSession(request, repository, now);
        const data = await form(request);
        if (!session || session.role !== "ADMIN" || !await csrfValid(request, data, env, session)) {
          return response("Forbidden", 403, "text/plain; charset=utf-8");
        }
        await repository.deleteSession(session.sessionHash);
        return redirect("/admin/login", [clearedCookie(SESSION_COOKIE, true), clearedCookie(CSRF_COOKIE)]);
      }

      const actionMatch = /^\/admin\/users\/([^/]+)\/(approve|reject|disable|enable|expire|rotate|delete)$/.exec(url.pathname);
      if (request.method === "POST" && actionMatch) {
        const session = await authenticatedSession(request, repository, now);
        const data = await form(request);
        if (!session || session.role !== "ADMIN" || !await csrfValid(request, data, env, session)) {
          return response("Forbidden", 403, "text/plain; charset=utf-8");
        }
        const userId = decodeURIComponent(actionMatch[1]);
        const action = actionMatch[2];
        const user = await repository.getUser(userId);
        if (!user) return response("Not found", 404, "text/plain; charset=utf-8");
        const timestamp = new Date(now).toISOString();
        if (action === "approve") {
          if (user.status !== "PENDING") return response("Conflict", 409, "text/plain; charset=utf-8");
          await repository.approveUser(user.id, await encryptedCredential(user.id, env, timestamp), session.principalId, timestamp);
        } else if (action === "reject") {
          await repository.setUserStatus(user.id, "REJECTED", session.principalId, "reject", timestamp);
        } else if (action === "disable") {
          await repository.setUserStatus(user.id, "DISABLED", session.principalId, "disable", timestamp);
        } else if (action === "enable") {
          await repository.setUserStatus(user.id, "APPROVED", session.principalId, "enable", timestamp);
        } else if (action === "expire") {
          const requested = data.get("expiresAt");
          const expiry = requested === "never" ? null : requested;
          if (expiry !== null && (typeof expiry !== "string" || !validIsoTimestamp(expiry))) {
            return response("Invalid expiry", 400, "text/plain; charset=utf-8");
          }
          await repository.setUserExpiry(user.id, expiry, session.principalId, timestamp);
        } else if (action === "rotate") {
          await repository.rotateCredential(user.id, await encryptedCredential(user.id, env, timestamp, true), session.principalId, timestamp);
        } else {
          if (data.get("confirm") !== "yes") return response("Confirmation required", 400, "text/plain; charset=utf-8");
          await repository.deleteUser(user.id, session.principalId, timestamp);
        }
        return redirect("/admin");
      }
      if (request.method !== "GET" && request.method !== "POST") return response("Method not allowed", 405, "text/plain; charset=utf-8");
      return response("Not found", 404, "text/plain; charset=utf-8");
    } catch {
      return response("服务暂时不可用，请稍后重试。", 500, "text/plain; charset=utf-8");
    }
  };
}

export default { fetch: createPortalHandler() } satisfies ExportedHandler<PortalEnv>;
