import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { sha256Hex } from "../src/hash";
import {
  readStagingFriendToken,
  resolveStagingFriendsFile,
  resolveStagingUrl,
  resolveTestProxy,
  StagingConfigError,
} from "./lib/staging-verification";

function curlStatus(url: string, output: string, proxy?: string, headerFile?: string, headers: string[] = []): number {
  const args = ["--silent", "--show-error", "--max-time", "30", "--output", output, "--write-out", "%{http_code}"];
  if (proxy) args.push("--proxy", proxy);
  if (headerFile) args.push("--dump-header", headerFile);
  for (const header of headers) args.push("--header", header);
  args.push(url);
  const result = spawnSync("curl", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error("STAGING_REQUEST_FAILED");
  return Number(result.stdout);
}

function parseHeaders(text: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0) headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return headers;
}

async function main(): Promise<void> {
  const baseUrl = resolveStagingUrl(process.env.STAGING_URL);
  const proxy = resolveTestProxy(process.env);
  const token = await readStagingFriendToken(resolveStagingFriendsFile(process.env));

  const identifier = randomUUID();
  const scratch = tmpdir();
  const nullOutput = join(scratch, `zackcloud-lite-null-${identifier}`);
  const headersFile = join(scratch, `zackcloud-lite-headers-${identifier}`);
  const revalidateOutput = join(scratch, `zackcloud-lite-304-${identifier}`);
  const safeDirectory = join(homedir(), ".local", "share", "zackcloud-lite");
  const temporarySubscription = join(safeDirectory, `.staging-${identifier}.yaml`);
  const finalSubscription = join(safeDirectory, "staging-subscription.yaml");

  try {
    await mkdir(safeDirectory, { recursive: true });
    const health = curlStatus(new URL("/health", baseUrl).href, nullOutput, proxy);
    const invalid = curlStatus(new URL("/sub/definitely-invalid-v03", baseUrl).href, nullOutput, proxy);
    const valid = curlStatus(new URL(`/sub/${encodeURIComponent(token)}`, baseUrl).href, temporarySubscription, proxy, headersFile);
    if (health !== 200 || invalid !== 404 || valid !== 200) {
      console.log(`HEALTH=${health}`);
      console.log(`INVALID_TOKEN=${invalid}`);
      console.log(`VALID_SUBSCRIPTION=${valid}`);
      console.log("ETAG_PRESENT=NOT_RUN");
      console.log("ETAG_TEST=NOT_RUN");
      console.log("SUBSCRIPTION_USERINFO_HEADER=NOT_RUN");
      console.log("PROFILE_UPDATE_INTERVAL_HEADER=NOT_RUN");
      console.log("VERIFY_STAGING=FAIL");
      throw new Error("STAGING_HTTP_VERIFICATION_FAILED");
    }

    await chmod(temporarySubscription, 0o600);
    const yaml = await readFile(temporarySubscription, "utf8");
    const document = parse(yaml) as { proxies?: unknown[] };
    const headers = parseHeaders(await readFile(headersFile, "utf8"));
    const etag = headers.get("etag") ?? "";
    const etagPresent = etag.length > 0;
    const hashMatch = etag === `"${await sha256Hex(yaml)}"`;
    const subscriptionUserinfoPresent = headers.has("subscription-userinfo");
    const profileUpdateIntervalPresent = headers.has("profile-update-interval");
    const etagStatus = curlStatus(
      new URL(`/sub/${encodeURIComponent(token)}`, baseUrl).href,
      revalidateOutput,
      proxy,
      undefined,
      [`If-None-Match: ${etag}`],
    );
    const etagPass = etagStatus === 304 && hashMatch;
    const contentPass = Array.isArray(document.proxies) && document.proxies.length > 0 && etagPass &&
      subscriptionUserinfoPresent && profileUpdateIntervalPresent;
    if (!contentPass) {
      console.log(`HEALTH=${health}`);
      console.log(`INVALID_TOKEN=${invalid}`);
      console.log(`VALID_SUBSCRIPTION=${valid}`);
      console.log(`ETAG_PRESENT=${etagPresent ? "PASS" : "FAIL"}`);
      console.log(`ETAG_TEST=${etagPass ? "PASS" : "FAIL"}`);
      console.log(`SUBSCRIPTION_USERINFO_HEADER=${subscriptionUserinfoPresent ? "PRESENT" : "MISSING"}`);
      console.log(`PROFILE_UPDATE_INTERVAL_HEADER=${profileUpdateIntervalPresent ? "PRESENT" : "MISSING"}`);
      console.log("VERIFY_STAGING=FAIL");
      throw new Error("STAGING_CONTENT_VERIFICATION_FAILED");
    }

    await rename(temporarySubscription, finalSubscription);
    await chmod(finalSubscription, 0o600);
    console.log(`HEALTH=${health}`);
    console.log(`INVALID_TOKEN=${invalid}`);
    console.log(`VALID_SUBSCRIPTION=${valid}`);
    console.log("ETAG_PRESENT=PASS");
    console.log("ETAG_TEST=PASS");
    console.log("SUBSCRIPTION_USERINFO_HEADER=PRESENT");
    console.log("PROFILE_UPDATE_INTERVAL_HEADER=PRESENT");
    console.log("VERIFY_STAGING=PASS");
  } finally {
    await Promise.all([
      rm(nullOutput, { force: true }),
      rm(headersFile, { force: true }),
      rm(revalidateOutput, { force: true }),
      rm(temporarySubscription, { force: true }),
    ]);
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof StagingConfigError) console.log(error.code);
  else if (!(error instanceof Error) || !error.message.startsWith("STAGING_")) console.log("VERIFY_STAGING_FAILED");
  else if (!error.message.endsWith("VERIFICATION_FAILED")) console.log(error.message);
  process.exitCode = 1;
}
