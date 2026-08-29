import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { sha256Hex } from "../src/hash";
import { resolveStagingUrl, resolveTestProxy, StagingConfigError } from "./lib/staging-verification";

function parseDevVars(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator > 0) {
      const key = line.slice(0, separator).trim();
      const rawValue = line.slice(separator + 1).trim();
      let value = rawValue;
      if (rawValue.startsWith("'") && rawValue.endsWith("'")) value = rawValue.slice(1, -1);
      else if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
        try { value = JSON.parse(rawValue) as string; } catch { value = rawValue.slice(1, -1); }
      }
      values.set(key, value);
    }
  }
  return values;
}

function selectToken(values: Map<string, string>): string {
  try {
    const friends = JSON.parse(values.get("FRIENDS_CONFIG_JSON") ?? "[]") as Array<{ token?: unknown; enabled?: unknown }>;
    const token = friends.find((friend) => friend.enabled === true && typeof friend.token === "string")?.token;
    if (typeof token === "string") return token;
  } catch {
    // Fall through to the legacy local token.
  }
  return (values.get("ALLOWED_TOKENS") ?? "").split(",").map((token) => token.trim()).find(Boolean) ?? "";
}

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
  const values = parseDevVars(await readFile(new URL("../.dev.vars", import.meta.url), "utf8"));
  const token = selectToken(values);
  if (!token) throw new Error("STAGING_TOKEN_NOT_CONFIGURED");

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
      console.log("ETAG_TEST=NOT_RUN");
      console.log("METADATA=NOT_RUN");
      throw new Error("STAGING_HTTP_VERIFICATION_FAILED");
    }

    await chmod(temporarySubscription, 0o600);
    const yaml = await readFile(temporarySubscription, "utf8");
    const document = parse(yaml) as { proxies?: unknown[] };
    const headers = parseHeaders(await readFile(headersFile, "utf8"));
    const etag = headers.get("etag") ?? "";
    const hashMatch = etag === `"${await sha256Hex(yaml)}"`;
    const metadataPresent = headers.has("subscription-userinfo") && headers.has("profile-update-interval");
    const etagStatus = curlStatus(
      new URL(`/sub/${encodeURIComponent(token)}`, baseUrl).href,
      revalidateOutput,
      proxy,
      undefined,
      [`If-None-Match: ${etag}`],
    );
    const etagPass = etagStatus === 304 && hashMatch;
    if (!Array.isArray(document.proxies) || document.proxies.length === 0 || !etagPass || !metadataPresent) {
      console.log(`HEALTH=${health}`);
      console.log(`INVALID_TOKEN=${invalid}`);
      console.log(`VALID_SUBSCRIPTION=${valid}`);
      console.log(`ETAG_TEST=${etagPass ? "PASS" : "FAIL"}`);
      console.log(`METADATA=${metadataPresent ? "PASS" : "FAIL"}`);
      throw new Error("STAGING_CONTENT_VERIFICATION_FAILED");
    }

    await rename(temporarySubscription, finalSubscription);
    await chmod(finalSubscription, 0o600);
    console.log(`HEALTH=${health}`);
    console.log(`INVALID_TOKEN=${invalid}`);
    console.log(`VALID_SUBSCRIPTION=${valid}`);
    console.log("ETAG_TEST=PASS");
    console.log("METADATA=PASS");
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
