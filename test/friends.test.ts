import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  addFriend,
  expireFriend,
  migrateWorkerFriendConfig,
  readFriendStore,
  removeFriend,
  requireRemovalConfirmation,
  rotateFriend,
  safeFriendListLines,
  secureToken,
  serializeFriendsForWorker,
  setFriendEnabled,
  validateFriendStore,
  writeFriendStoreAtomic,
  type FriendRecord,
} from "../scripts/lib/friend-store";
import { deployFriendSecret, eligibleFriend } from "../scripts/lib/friend-remote";

const NOW = Date.parse("2026-08-29T00:00:00Z");
const TOKEN_A = "example-token-value-aaaaaaaaaaaa";
const TOKEN_B = "example-token-value-bbbbbbbbbbbb";

function friend(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    token: TOKEN_A,
    name: "Alice",
    enabled: true,
    expiresAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("friend lifecycle", () => {
  it("adds a friend with safe defaults", () => {
    const result = addFriend([], " Alice ", NOW, () => TOKEN_A);
    expect(result.friend).toMatchObject({ name: "Alice", enabled: true, expiresAt: null, token: TOKEN_A });
    expect(result.friends).toHaveLength(1);
  });

  it("rejects a duplicate name", () => {
    expect(() => addFriend([friend()], "Alice", NOW, () => TOKEN_B)).toThrowError("FRIEND_NAME_DUPLICATE");
  });

  it("creates cryptographically generated unique token values", () => {
    const first = secureToken();
    const second = secureToken();
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(40);
    expect(first).not.toMatch(/[\\/]/);
  });

  it("redacts tokens in list output", () => {
    const lines = safeFriendListLines([friend()], NOW);
    const output = lines.join("\n");
    expect(output).not.toContain(TOKEN_A);
    expect(output).toContain(`TOKEN_SUFFIX=${TOKEN_A.slice(-4)}`);
    expect(output).toContain("STATUS=ACTIVE");
  });

  it("disables and enables a friend", () => {
    const disabled = setFriendEnabled([friend()], "Alice", false, NOW);
    expect(disabled[0].enabled).toBe(false);
    const enabled = setFriendEnabled(disabled, "Alice", true, NOW + 1_000);
    expect(enabled[0].enabled).toBe(true);
  });

  it("rotates a token and removes the old token", () => {
    const result = rotateFriend([friend()], "Alice", NOW, () => TOKEN_B);
    expect(result.friend.token).toBe(TOKEN_B);
    expect(JSON.stringify(result.friends)).not.toContain(TOKEN_A);
  });

  it("requires explicit confirmation before removal", () => {
    expect(() => requireRemovalConfirmation(false)).toThrowError("REMOVE_CONFIRMATION_REQUIRED");
    expect(() => requireRemovalConfirmation(true)).not.toThrow();
    expect(removeFriend([friend()], "Alice")).toEqual([]);
  });

  it("sets a valid expiry and supports never", () => {
    const expiring = expireFriend([friend()], "Alice", "2026-12-31T23:59:59+08:00", NOW);
    expect(expiring[0].expiresAt).toBe("2026-12-31T23:59:59+08:00");
    expect(expireFriend(expiring, "Alice", "never", NOW)[0].expiresAt).toBeNull();
  });

  it.each(["not-a-date", "2026-02-30T00:00:00Z", "2026-12-31"])("rejects invalid expiry %s", (expiry) => {
    expect(() => expireFriend([friend()], "Alice", expiry, NOW)).toThrowError("FRIEND_EXPIRY_INVALID");
  });
});

describe("private friend store", () => {
  async function temporaryStore(callback: (path: string) => Promise<void>): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "zackcloud-lite-friends-test-"));
    try {
      await callback(join(directory, "private", "friends.json"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  it("treats a missing store as empty only when creation is allowed", async () => {
    await temporaryStore(async (path) => {
      await expect(readFriendStore(path, true)).resolves.toEqual([]);
      await expect(readFriendStore(path)).rejects.toThrowError("FRIEND_STORE_NOT_AVAILABLE");
    });
  });

  it("rejects invalid JSON", async () => {
    await temporaryStore(async (path) => {
      const invalidPath = join(dirname(dirname(path)), "invalid.json");
      await writeFile(invalidPath, "{", "utf8");
      await expect(readFriendStore(invalidPath)).rejects.toThrowError("FRIEND_STORE_INVALID");
    });
  });

  it("rejects duplicate tokens and duplicate names", () => {
    expect(() => validateFriendStore([friend(), friend({ name: "Bob" })])).toThrowError("FRIEND_STORE_INVALID");
    expect(() => validateFriendStore([friend(), friend({ token: TOKEN_B })])).toThrowError("FRIEND_STORE_INVALID");
  });

  it("migrates a validated Worker friend config without changing credentials", () => {
    const migrated = migrateWorkerFriendConfig([{
      token: TOKEN_A,
      name: "Alice",
      enabled: true,
      expiresAt: null,
    }], NOW);
    expect(migrated[0]).toMatchObject({ token: TOKEN_A, name: "Alice", enabled: true, expiresAt: null });
    expect(migrated[0].createdAt).toBe(new Date(NOW).toISOString());
  });

  it("writes atomically with private directory and file permissions", async () => {
    await temporaryStore(async (path) => {
      await writeFriendStoreAtomic(path, [friend()]);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await expect(readFriendStore(path)).resolves.toEqual([friend()]);
      const leftovers = await readFile(path, "utf8");
      expect(leftovers.endsWith("\n")).toBe(true);
    });
  });

  it("does not damage an existing store when validation fails", async () => {
    await temporaryStore(async (path) => {
      await writeFriendStoreAtomic(path, [friend()]);
      const before = await readFile(path, "utf8");
      await expect(writeFriendStoreAtomic(path, [friend(), friend({ name: "Bob" })])).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(before);
    });
  });
});

describe("friend deployment and verification", () => {
  it("allows an empty validated deployment", () => {
    expect(deployFriendSecret([], "zackcloud-lite-staging", (_worker, payload) => payload === "[]"))
      .toEqual({ friendCount: 0 });
  });

  it("serializes only Worker-compatible fields", () => {
    const serialized = serializeFriendsForWorker([friend()]);
    expect(JSON.parse(serialized)).toEqual([{
      token: TOKEN_A,
      name: "Alice",
      enabled: true,
      expiresAt: null,
    }]);
    expect(serialized).not.toContain("createdAt");
    expect(serialized).not.toContain("updatedAt");
  });

  it("passes the secret through stdin payload without logging it", () => {
    let captured = "";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(deployFriendSecret([friend()], "zackcloud-lite-staging", (_worker, payload) => {
        captured = payload;
        return true;
      })).toEqual({ friendCount: 1 });
      expect(captured).toContain(TOKEN_A);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("fails closed when remote deployment fails", () => {
    const original = [friend()];
    expect(() => deployFriendSecret(original, "zackcloud-lite-staging", () => false))
      .toThrowError("REMOTE_DEPLOY_FAILED");
    expect(original).toEqual([friend()]);
  });

  it("finds an active friend for verification", () => {
    expect(eligibleFriend([friend()], "Alice", NOW)?.name).toBe("Alice");
  });

  it("rejects disabled and expired friends for verification", () => {
    expect(eligibleFriend([friend({ enabled: false })], "Alice", NOW)).toBeUndefined();
    expect(eligibleFriend([friend({ expiresAt: "2026-01-01T00:00:00Z" })], "Alice", NOW)).toBeUndefined();
  });
});
