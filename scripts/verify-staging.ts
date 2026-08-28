import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { detectSubscriptionFormat } from "../src/converter/detector";
import { sha256Hex } from "../src/hash";

function parseDevVars(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
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

function curlStatus(url: string, output: string, headerFile?: string, headers: string[] = []): number {
  const args = [
    "--silent", "--show-error", "--max-time", "30",
    "--proxy", "http://127.0.0.1:10090",
    "--output", output,
    "--write-out", "%{http_code}",
  ];
  if (headerFile) args.push("--dump-header", headerFile);
  for (const header of headers) args.push("--header", header);
  args.push(url);
  const result = spawnSync("curl", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error("staging request failed");
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

const baseUrl = new URL(process.env.STAGING_URL ?? "");
if (baseUrl.protocol !== "https:" || !baseUrl.hostname.startsWith("zackcloud-lite-staging.") ||
    !baseUrl.hostname.endsWith(".workers.dev")) throw new Error("invalid staging target");

const values = parseDevVars(await readFile(new URL("../.dev.vars", import.meta.url), "utf8"));
const token = selectToken(values);
if (!token) throw new Error("no local staging token configured");

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
  const health = curlStatus(new URL("/health", baseUrl).href, nullOutput);
  const invalid = curlStatus(new URL("/sub/definitely-invalid-v03", baseUrl).href, nullOutput);
  const valid = curlStatus(new URL(`/sub/${encodeURIComponent(token)}`, baseUrl).href, temporarySubscription, headersFile);
  await chmod(temporarySubscription, 0o600);
  const yaml = await readFile(temporarySubscription, "utf8");
  const headers = parseHeaders(await readFile(headersFile, "utf8"));
  const etag = headers.get("etag") ?? "";
  const hashMatch = etag === `"${await sha256Hex(yaml)}"`;
  const etagStatus = curlStatus(new URL(`/sub/${encodeURIComponent(token)}`, baseUrl).href, revalidateOutput, undefined, [`If-None-Match: ${etag}`]);

  const document = parse(yaml) as { proxies?: Array<{ name?: string; type?: string }> };
  const proxies = Array.isArray(document.proxies) ? document.proxies : [];
  const regionCounts: Record<string, number> = {};
  const typeCounts: Record<string, number> = {};
  for (const proxy of proxies) {
    const region = typeof proxy.name === "string" ? /^\S+ 扎克云 · (.+) \d{2,}$/.exec(proxy.name)?.[1] ?? "其他" : "其他";
    regionCounts[region] = (regionCounts[region] ?? 0) + 1;
    const type = typeof proxy.type === "string" ? proxy.type.toLowerCase() : "unknown";
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
  }
  if (health !== 200 || invalid !== 404 || valid !== 200 || etagStatus !== 304 || !hashMatch || proxies.length === 0) {
    throw new Error("staging verification failed");
  }
  await rename(temporarySubscription, finalSubscription);
  await chmod(finalSubscription, 0o600);

  const metadataHeaders = ["subscription-userinfo", "profile-update-interval"].filter((name) => headers.has(name));
  console.log(`HEALTH=${health}`);
  console.log(`INVALID_TOKEN=${invalid}`);
  console.log(`CLOUDFLARE_SUB_HTTP=${valid}`);
  console.log(`CLOUDFLARE_PROXY_COUNT=${proxies.length}`);
  console.log(`FORMAT=${detectSubscriptionFormat(yaml)}`);
  console.log(`REGION_COUNTS=${JSON.stringify(regionCounts)}`);
  console.log(`TYPE_COUNTS=${JSON.stringify(typeCounts)}`);
  console.log(`HASH_MATCH=${hashMatch ? "PASS" : "FAIL"}`);
  console.log(`METADATA_HEADERS=${metadataHeaders.length > 0 ? metadataHeaders.join(",") : "NONE"}`);
  console.log(`ETAG_TEST=${etagStatus === 304 ? "PASS" : "FAIL"}`);
} finally {
  await Promise.all([
    rm(nullOutput, { force: true }),
    rm(headersFile, { force: true }),
    rm(revalidateOutput, { force: true }),
    rm(temporarySubscription, { force: true }),
  ]);
}
