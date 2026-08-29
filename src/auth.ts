import type { Env } from "./types";
import { sha256Hex } from "./hash";

interface FriendConfig {
  token: string;
  enabled: boolean;
  expiresAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFriends(value: string | undefined): FriendConfig[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is FriendConfig =>
      isRecord(entry) && typeof entry.token === "string" && typeof entry.enabled === "boolean" &&
      (entry.expiresAt === null || typeof entry.expiresAt === "string"));
  } catch {
    return [];
  }
}

function validFriend(friend: FriendConfig, now: number): boolean {
  if (!friend.enabled) return false;
  if (friend.expiresAt === null) return true;
  const expiresAt = Date.parse(friend.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

interface D1CredentialStatus {
  status: string;
  expires_at: string | null;
}

export async function isTokenAllowed(token: string, env: Env, now = Date.now()): Promise<boolean> {
  if (!token || token.length > 512 || token.includes("/") || token.includes("\\") ||
    [...token].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return false;
  if (env.AUTH_DB) {
    try {
      const credential = await env.AUTH_DB.prepare(`SELECT users.status, users.expires_at
        FROM subscription_credentials
        JOIN users ON users.id = subscription_credentials.user_id
        WHERE subscription_credentials.token_hash = ? LIMIT 1`)
        .bind(await sha256Hex(token)).first<D1CredentialStatus>();
      if (credential) {
        return credential.status === "APPROVED" &&
          (credential.expires_at === null || Date.parse(credential.expires_at) > now);
      }
    } catch {
      // During migration, a D1 outage must not revoke an otherwise valid legacy friend.
    }
  }
  const legacy = new Set((env.ALLOWED_TOKENS ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  if (legacy.has(token)) return true;
  return parseFriends(env.FRIENDS_CONFIG_JSON).some((friend) => friend.token === token && validFriend(friend, now));
}
