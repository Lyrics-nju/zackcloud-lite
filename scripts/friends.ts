import { readFile } from "node:fs/promises";
import {
  addFriend,
  expireFriend,
  migrateWorkerFriendConfig,
  readFriendStore,
  removeFriend,
  requireRemovalConfirmation,
  resolveFriendStorePath,
  rotateFriend,
  safeFriendListLines,
  setFriendEnabled,
  writeFriendStoreAtomic,
  FriendStoreError,
} from "./lib/friend-store";
import { curlVerifyFriend, deployFriendSecret, eligibleFriend } from "./lib/friend-remote";
import {
  resolveStagingFriendsFile,
  resolveStagingUrl,
  resolveTestProxy,
  StagingConfigError,
} from "./lib/staging-verification";

const [command, ...args] = process.argv.slice(2);
const filePath = resolveFriendStorePath(process.env);

function subscriptionUrl(token: string): string | null {
  const configured = process.env.ZACKCLOUD_PUBLIC_BASE_URL?.trim();
  if (!configured) return null;
  try {
    const base = new URL(configured);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
      throw new Error();
    }
    return new URL(`/sub/${encodeURIComponent(token)}`, base).href;
  } catch {
    throw new Error("PUBLIC_BASE_URL_INVALID");
  }
}

function printCreated(name: string, token: string): void {
  console.log("FRIEND_CREATED=PASS");
  console.log(`NAME=${name}`);
  console.log(`SUBSCRIPTION_URL=${subscriptionUrl(token) ?? "NOT_CONFIGURED"}`);
}

async function deployCurrent(): Promise<number> {
  const friends = await readFriendStore(filePath);
  const worker = process.env.ZACKCLOUD_WORKER_NAME?.trim() || "zackcloud-lite-staging";
  const { friendCount } = deployFriendSecret(friends, worker);
  console.log("FRIENDS_VALIDATION=PASS");
  console.log(`FRIEND_COUNT=${friendCount}`);
  console.log("CLOUDFLARE_SECRET_UPDATE=PASS");
  return friendCount;
}

async function main(): Promise<void> {
  if (command === "add") {
    const current = await readFriendStore(filePath, true);
    const result = addFriend(current, args[0]);
    subscriptionUrl(result.friend.token);
    await writeFriendStoreAtomic(filePath, result.friends);
    printCreated(result.friend.name, result.friend.token);
    return;
  }
  if (command === "list") {
    const friends = await readFriendStore(filePath, true);
    console.log(`FRIEND_COUNT=${friends.length}`);
    for (const line of safeFriendListLines(friends)) console.log(line);
    return;
  }
  if (command === "disable" || command === "enable") {
    const updated = setFriendEnabled(await readFriendStore(filePath), args[0], command === "enable");
    await writeFriendStoreAtomic(filePath, updated);
    console.log(`FRIEND_${command.toUpperCase()}D=PASS`);
    return;
  }
  if (command === "rotate") {
    const result = rotateFriend(await readFriendStore(filePath), args[0]);
    subscriptionUrl(result.friend.token);
    await writeFriendStoreAtomic(filePath, result.friends);
    console.log("OLD_TOKEN_REVOKED=PASS");
    console.log(`SUBSCRIPTION_URL=${subscriptionUrl(result.friend.token) ?? "NOT_CONFIGURED"}`);
    return;
  }
  if (command === "remove") {
    requireRemovalConfirmation(args.includes("--yes"));
    const updated = removeFriend(await readFriendStore(filePath), args.find((value) => value !== "--yes"));
    await writeFriendStoreAtomic(filePath, updated);
    console.log("FRIEND_REMOVED=PASS");
    return;
  }
  if (command === "expire") {
    const updated = expireFriend(await readFriendStore(filePath), args[0], args[1]);
    await writeFriendStoreAtomic(filePath, updated);
    console.log("FRIEND_EXPIRY_UPDATED=PASS");
    return;
  }
  if (command === "deploy") {
    await deployCurrent();
    return;
  }
  if (command === "migrate-staging") {
    try {
      await readFriendStore(filePath);
      throw new Error("FRIEND_STORE_ALREADY_EXISTS");
    } catch (error) {
      if (!(error instanceof FriendStoreError) || error.code !== "FRIEND_STORE_NOT_AVAILABLE") throw error;
    }
    let source: unknown;
    try {
      source = JSON.parse(await readFile(resolveStagingFriendsFile(process.env), "utf8"));
    } catch {
      throw new FriendStoreError("FRIEND_STORE_NOT_AVAILABLE");
    }
    const migrated = migrateWorkerFriendConfig(source);
    await writeFriendStoreAtomic(filePath, migrated);
    console.log("FRIEND_MIGRATION=PASS");
    console.log(`FRIEND_COUNT=${migrated.length}`);
    return;
  }
  if (command === "add-and-deploy") {
    const current = await readFriendStore(filePath, true);
    const result = addFriend(current, args[0]);
    subscriptionUrl(result.friend.token);
    await writeFriendStoreAtomic(filePath, result.friends);
    try {
      await deployCurrent();
    } catch {
      console.log("REMOTE_DEPLOY=FAIL");
      console.log("LOCAL_STATE_UPDATED=YES");
      console.log("REMOTE_STATE_UPDATED=NO");
      process.exitCode = 1;
      return;
    }
    console.log("LOCAL_STATE_UPDATED=YES");
    console.log("REMOTE_STATE_UPDATED=YES");
    printCreated(result.friend.name, result.friend.token);
    return;
  }
  if (command === "verify") {
    const friends = await readFriendStore(filePath);
    const friend = eligibleFriend(friends, args[0] ?? "");
    if (!friend) {
      console.log("FRIEND_FOUND=FAIL");
      console.log("SUB_HTTP=NOT_RUN");
      console.log("ETAG_PRESENT=FAIL");
      console.log("VERIFY=FAIL");
      process.exitCode = 1;
      return;
    }
    const result = await curlVerifyFriend(
      resolveStagingUrl(process.env.STAGING_URL),
      friend.token,
      resolveTestProxy(process.env),
    );
    const pass = result.status === 200 && result.etagPresent;
    console.log("FRIEND_FOUND=PASS");
    console.log(`SUB_HTTP=${result.status ?? "REQUEST_FAILED"}`);
    console.log(`ETAG_PRESENT=${result.etagPresent ? "PASS" : "FAIL"}`);
    console.log(`VERIFY=${pass ? "PASS" : "FAIL"}`);
    if (!pass) process.exitCode = 1;
    return;
  }
  throw new Error("FRIEND_COMMAND_INVALID");
}

try {
  await main();
} catch (error) {
  const reason = error instanceof FriendStoreError || error instanceof StagingConfigError
    ? error.message
    : error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message
      : "FRIEND_COMMAND_FAILED";
  console.log("FRIEND_COMMAND=FAIL");
  console.log(`REASON=${reason}`);
  process.exitCode = 1;
}
