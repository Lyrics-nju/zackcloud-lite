import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type StagingConfigErrorCode =
  | "STAGING_URL_NOT_CONFIGURED"
  | "STAGING_URL_INVALID"
  | "CUSTOM_DOMAIN_URL_INVALID"
  | "TEST_PROXY_INVALID"
  | "STAGING_FRIEND_TOKEN_NOT_AVAILABLE";

export class StagingConfigError extends Error {
  constructor(readonly code: StagingConfigErrorCode) {
    super(code);
    this.name = "StagingConfigError";
  }
}

export function resolveStagingUrl(value: string | undefined): URL {
  if (!value?.trim()) throw new StagingConfigError("STAGING_URL_NOT_CONFIGURED");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        url.pathname !== "/" || url.search || url.hash ||
        !url.hostname.startsWith("zackcloud-lite-staging.") || !url.hostname.endsWith(".workers.dev")) {
      throw new StagingConfigError("STAGING_URL_INVALID");
    }
    return url;
  } catch (error) {
    if (error instanceof StagingConfigError) throw error;
    throw new StagingConfigError("STAGING_URL_INVALID");
  }
}

export function resolveCustomDomainUrl(value: string | undefined): URL | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "sub.zackcloud.site" || url.username || url.password ||
        url.port || url.pathname !== "/" || url.search || url.hash) {
      throw new StagingConfigError("CUSTOM_DOMAIN_URL_INVALID");
    }
    return url;
  } catch (error) {
    if (error instanceof StagingConfigError) throw error;
    throw new StagingConfigError("CUSTOM_DOMAIN_URL_INVALID");
  }
}

export interface CustomDomainVerificationStatus {
  health: number | "REQUEST_FAILED";
  subscription: number | "NOT_RUN" | "REQUEST_FAILED";
  etagPass: boolean;
}

export function customDomainVerificationLines(status: CustomDomainVerificationStatus): string[] {
  const pass = status.health === 200 && status.subscription === 200 && status.etagPass;
  return [
    `CUSTOM_DOMAIN_HEALTH=${status.health}`,
    `CUSTOM_DOMAIN_SUBSCRIPTION=${status.subscription}`,
    `CUSTOM_DOMAIN_ETAG=${status.etagPass ? "PASS" : "FAIL"}`,
    `CUSTOM_DOMAIN_VERIFY=${pass ? "PASS" : "FAIL"}`,
  ];
}

export function resolveTestProxy(environment: Record<string, string | undefined>): string | undefined {
  const value = environment.ZACKCLOUD_TEST_PROXY ?? environment.HTTPS_PROXY ?? environment.HTTP_PROXY;
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw new StagingConfigError("TEST_PROXY_INVALID");
    }
    return url.href;
  } catch (error) {
    if (error instanceof StagingConfigError) throw error;
    throw new StagingConfigError("TEST_PROXY_INVALID");
  }
}

export function resolveStagingFriendsFile(
  environment: Record<string, string | undefined>,
  homeDirectory = homedir(),
): string {
  return environment.ZACKCLOUD_STAGING_FRIENDS_FILE?.trim() ||
    join(homeDirectory, ".local", "share", "zackcloud-lite", "staging-friends.json");
}

function validToken(token: unknown): token is string {
  return typeof token === "string" && token.length > 0 && token.length <= 512 &&
    !token.includes("/") && !token.includes("\\") &&
    ![...token].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

export async function readStagingFriendToken(filePath: string, now = Date.now()): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (!Array.isArray(parsed)) throw new Error();
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const friend = entry as Record<string, unknown>;
      if (friend.enabled !== true || !validToken(friend.token)) continue;
      if (friend.expiresAt === null) return friend.token;
      if (typeof friend.expiresAt === "string") {
        const expiresAt = Date.parse(friend.expiresAt);
        if (Number.isFinite(expiresAt) && expiresAt > now) return friend.token;
      }
    }
  } catch {
    // Every file and content failure intentionally maps to the same safe code.
  }
  throw new StagingConfigError("STAGING_FRIEND_TOKEN_NOT_AVAILABLE");
}
