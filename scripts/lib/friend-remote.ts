import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FriendRecord } from "./friend-store";
import { isFriendActive, serializeFriendsForWorker } from "./friend-store";

export type SecretRunner = (workerName: string, payload: string) => boolean;

function validWorkerName(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

export function deployFriendSecret(
  friends: FriendRecord[],
  workerName: string,
  runner: SecretRunner = runWranglerSecretPut,
): { friendCount: number } {
  if (!validWorkerName(workerName)) throw new Error("WORKER_NAME_INVALID");
  const payload = serializeFriendsForWorker(friends);
  if (!runner(workerName, payload)) throw new Error("REMOTE_DEPLOY_FAILED");
  return { friendCount: friends.length };
}

function runWranglerSecretPut(workerName: string, payload: string): boolean {
  const result = spawnSync(
    "npx",
    ["wrangler", "secret", "put", "FRIENDS_CONFIG_JSON", "--name", workerName],
    {
      cwd: new URL("../../", import.meta.url),
      env: process.env,
      encoding: "utf8",
      input: `${payload}\n`,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  return result.status === 0;
}

export interface FriendVerificationResult {
  found: boolean;
  status: number | null;
  etagPresent: boolean;
}

export function eligibleFriend(friends: FriendRecord[], name: string, now = Date.now()): FriendRecord | undefined {
  return friends.find((friend) => friend.name === name && isFriendActive(friend, now));
}

export async function curlVerifyFriend(
  baseUrl: URL,
  token: string,
  proxy?: string,
): Promise<FriendVerificationResult> {
  const identifier = [...randomBytes(12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const bodyFile = join(tmpdir(), `zackcloud-lite-friend-body-${identifier}`);
  const headerFile = join(tmpdir(), `zackcloud-lite-friend-headers-${identifier}`);
  try {
    await Promise.all([
      writeFile(bodyFile, "", { encoding: "utf8", mode: 0o600 }),
      writeFile(headerFile, "", { encoding: "utf8", mode: 0o600 }),
    ]);
    const args = [
      "--silent", "--max-time", "30", "--output", bodyFile, "--dump-header", headerFile,
      "--write-out", "%{http_code}",
    ];
    if (proxy) args.push("--proxy", proxy);
    args.push(new URL(`/sub/${encodeURIComponent(token)}`, baseUrl).href);
    const result = spawnSync("curl", args, { encoding: "utf8" });
    if (result.status !== 0) return { found: true, status: null, etagPresent: false };
    const headers = await readFile(headerFile, "utf8").catch(() => "");
    return {
      found: true,
      status: Number(result.stdout),
      etagPresent: /^etag\s*:/im.test(headers),
    };
  } finally {
    await Promise.all([rm(bodyFile, { force: true }), rm(headerFile, { force: true })]);
  }
}
