import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface FriendRecord {
  token: string;
  name: string;
  enabled: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FriendStoreErrorCode =
  | "FRIEND_STORE_NOT_AVAILABLE"
  | "FRIEND_STORE_INVALID"
  | "FRIEND_NAME_REQUIRED"
  | "FRIEND_NAME_DUPLICATE"
  | "FRIEND_NOT_FOUND"
  | "FRIEND_TOKEN_GENERATION_FAILED"
  | "FRIEND_EXPIRY_INVALID";

export class FriendStoreError extends Error {
  constructor(readonly code: FriendStoreErrorCode) {
    super(code);
    this.name = "FriendStoreError";
  }
}

export function resolveFriendStorePath(
  environment: Record<string, string | undefined>,
  homeDirectory = homedir(),
): string {
  return environment.ZACKCLOUD_FRIENDS_FILE?.trim() ||
    join(homeDirectory, ".local", "share", "zackcloud-lite", "friends.json");
}

export function validFriendToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && value.length <= 512 &&
    !value.includes("/") && !value.includes("\\") &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

export function validIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
      hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== "Z") {
    const [offsetHour, offsetMinute] = zone.slice(1).split(":").map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function normalizedName(value: unknown): string {
  if (typeof value !== "string") throw new FriendStoreError("FRIEND_NAME_REQUIRED");
  const name = value.trim();
  if (!name || name.length > 100 || [...name].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  })) throw new FriendStoreError("FRIEND_NAME_REQUIRED");
  return name;
}

export function validateFriendStore(value: unknown): FriendRecord[] {
  if (!Array.isArray(value)) throw new FriendStoreError("FRIEND_STORE_INVALID");
  const names = new Set<string>();
  const tokens = new Set<string>();
  const records: FriendRecord[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new FriendStoreError("FRIEND_STORE_INVALID");
    }
    const source = item as Record<string, unknown>;
    let name: string;
    try {
      name = normalizedName(source.name);
    } catch {
      throw new FriendStoreError("FRIEND_STORE_INVALID");
    }
    if (!validFriendToken(source.token) || typeof source.enabled !== "boolean" ||
        (source.expiresAt !== null && !validIsoTimestamp(source.expiresAt)) ||
        !validIsoTimestamp(source.createdAt) || !validIsoTimestamp(source.updatedAt)) {
      throw new FriendStoreError("FRIEND_STORE_INVALID");
    }
    if (names.has(name) || tokens.has(source.token)) throw new FriendStoreError("FRIEND_STORE_INVALID");
    names.add(name);
    tokens.add(source.token);
    records.push({
      token: source.token,
      name,
      enabled: source.enabled,
      expiresAt: source.expiresAt,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    });
  }
  return records;
}

export async function readFriendStore(filePath: string, allowMissing = false): Promise<FriendRecord[]> {
  try {
    return validateFriendStore(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new FriendStoreError("FRIEND_STORE_NOT_AVAILABLE");
    if (error instanceof FriendStoreError) throw error;
    throw new FriendStoreError("FRIEND_STORE_INVALID");
  }
}

export async function writeFriendStoreAtomic(filePath: string, friends: FriendRecord[]): Promise<void> {
  const validated = validateFriendStore(friends);
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryFile = join(directory, `.friends-${randomHex(12)}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryFile, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryFile, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryFile, { force: true });
  }
}

export function isFriendActive(friend: FriendRecord, now = Date.now()): boolean {
  return friend.enabled && (friend.expiresAt === null || Date.parse(friend.expiresAt) > now);
}

function uniqueToken(friends: FriendRecord[], tokenFactory: () => string): string {
  const existing = new Set(friends.map(({ token }) => token));
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const token = tokenFactory();
    if (validFriendToken(token) && !existing.has(token)) return token;
  }
  throw new FriendStoreError("FRIEND_TOKEN_GENERATION_FAILED");
}

export function secureToken(): string {
  return randomHex(32);
}

function randomHex(byteLength: number): string {
  return [...randomBytes(byteLength)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function addFriend(
  friends: FriendRecord[],
  requestedName: string | undefined,
  now = Date.now(),
  tokenFactory = secureToken,
): { friends: FriendRecord[]; friend: FriendRecord } {
  const name = normalizedName(requestedName);
  if (friends.some((friend) => friend.name === name)) throw new FriendStoreError("FRIEND_NAME_DUPLICATE");
  const timestamp = new Date(now).toISOString();
  const friend: FriendRecord = {
    token: uniqueToken(friends, tokenFactory),
    name,
    enabled: true,
    expiresAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return { friends: [...friends, friend], friend };
}

function friendIndex(friends: FriendRecord[], requestedName: string | undefined): number {
  const name = normalizedName(requestedName);
  const index = friends.findIndex((friend) => friend.name === name);
  if (index < 0) throw new FriendStoreError("FRIEND_NOT_FOUND");
  return index;
}

function replaceFriend(friends: FriendRecord[], index: number, replacement: FriendRecord): FriendRecord[] {
  return friends.map((friend, position) => position === index ? replacement : friend);
}

export function setFriendEnabled(
  friends: FriendRecord[], requestedName: string | undefined, enabled: boolean, now = Date.now(),
): FriendRecord[] {
  const index = friendIndex(friends, requestedName);
  return replaceFriend(friends, index, { ...friends[index], enabled, updatedAt: new Date(now).toISOString() });
}

export function rotateFriend(
  friends: FriendRecord[], requestedName: string | undefined, now = Date.now(), tokenFactory = secureToken,
): { friends: FriendRecord[]; friend: FriendRecord } {
  const index = friendIndex(friends, requestedName);
  const friend = { ...friends[index], token: uniqueToken(friends, tokenFactory), updatedAt: new Date(now).toISOString() };
  return { friends: replaceFriend(friends, index, friend), friend };
}

export function removeFriend(friends: FriendRecord[], requestedName: string | undefined): FriendRecord[] {
  const index = friendIndex(friends, requestedName);
  return friends.filter((_friend, position) => position !== index);
}

export function expireFriend(
  friends: FriendRecord[], requestedName: string | undefined, requestedExpiry: string | undefined, now = Date.now(),
): FriendRecord[] {
  const index = friendIndex(friends, requestedName);
  const expiresAt = requestedExpiry === "never" ? null : requestedExpiry;
  if (expiresAt !== null && !validIsoTimestamp(expiresAt)) throw new FriendStoreError("FRIEND_EXPIRY_INVALID");
  return replaceFriend(friends, index, { ...friends[index], expiresAt, updatedAt: new Date(now).toISOString() });
}

export function tokenSuffix(token: string): string {
  return token.slice(-4);
}

export function safeFriendListLines(friends: FriendRecord[], now = Date.now()): string[] {
  return friends.flatMap((friend) => [
    `NAME=${friend.name}`,
    `STATUS=${isFriendActive(friend, now) ? "ACTIVE" : friend.enabled ? "EXPIRED" : "DISABLED"}`,
    `EXPIRES=${friend.expiresAt ?? "NEVER"}`,
    `TOKEN_SUFFIX=${tokenSuffix(friend.token)}`,
  ]);
}

export function requireRemovalConfirmation(confirmed: boolean): void {
  if (!confirmed) throw new Error("REMOVE_CONFIRMATION_REQUIRED");
}

export function serializeFriendsForWorker(friends: FriendRecord[]): string {
  return JSON.stringify(validateFriendStore(friends).map(({ token, name, enabled, expiresAt }) => ({
    token,
    name,
    enabled,
    expiresAt,
  })));
}

export function migrateWorkerFriendConfig(value: unknown, now = Date.now()): FriendRecord[] {
  if (!Array.isArray(value)) throw new FriendStoreError("FRIEND_STORE_INVALID");
  const timestamp = new Date(now).toISOString();
  return validateFriendStore(value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new FriendStoreError("FRIEND_STORE_INVALID");
    }
    const source = item as Record<string, unknown>;
    return {
      token: source.token,
      name: source.name,
      enabled: source.enabled,
      expiresAt: source.expiresAt,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }));
}
