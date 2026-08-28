import type { Env } from "./types";

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

export function isTokenAllowed(token: string, env: Env, now = Date.now()): boolean {
  if (!token || token.length > 512 || token.includes("/") || token.includes("\\") ||
      [...token].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return false;
  const legacy = new Set((env.ALLOWED_TOKENS ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  if (legacy.has(token)) return true;
  return parseFriends(env.FRIENDS_CONFIG_JSON).some((friend) => friend.token === token && validFriend(friend, now));
}
