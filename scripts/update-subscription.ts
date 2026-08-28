import { spawnSync } from "node:child_process";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildFromUpstream, publishSnapshot } from "../src/publisher";
import { SnapshotValidationError } from "../src/snapshot";
import { UpstreamError } from "../src/upstream";

type Source = "local" | "env";

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

function argument(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function upstreamUrl(source: Source): Promise<string> {
  if (source === "env") return process.env.UPSTREAM_SUBSCRIPTION_URL ?? "";
  const file = await readFile(new URL("../.dev.vars", import.meta.url), "utf8");
  return parseDevVars(file).get("UPSTREAM_SUBSCRIPTION_URL") ?? "";
}

function printSummary(result: Awaited<ReturnType<typeof buildFromUpstream>>): void {
  console.log(`UPSTREAM_HTTP=200`);
  console.log(`FORMAT=${result.format}`);
  console.log(`PROXY_COUNT=${result.summary.proxyCount}`);
  console.log(`REGION_COUNTS=${JSON.stringify(result.summary.regionCounts)}`);
  console.log(`TYPE_COUNTS=${JSON.stringify(result.summary.typeCounts)}`);
  console.log(`NON_NAME_FIELDS_IDENTICAL=${result.summary.nonNameFieldsIdentical ? "PASS" : "FAIL"}`);
  console.log(`UNIQUE_NAMES=${result.summary.uniqueNames ? "PASS" : "FAIL"}`);
  console.log(`GROUP_REFERENCE_CHECK=${result.summary.groupReferenceCheck ? "PASS" : "FAIL"}`);
  console.log(`METADATA_WHITELIST=PASS`);
  console.log(`SNAPSHOT_SHA256_PREFIX=${result.snapshot.sha256.slice(0, 8)}`);
}

async function writeRemoteSnapshot(key: string, serialized: string, source: Source): Promise<void> {
  const temporaryFile = join(tmpdir(), `zackcloud-lite-snapshot-${randomUUID()}.json`);
  try {
    await writeFile(temporaryFile, serialized, { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryFile, 0o600);
    const args = ["wrangler", "kv", "key", "put", key, "--path", temporaryFile, "--remote"];
    if (source === "local") args.push("--binding", "SUBSCRIPTION_STORE", "--env", "staging");
    else {
      const namespaceId = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
      if (!namespaceId) throw new Error("missing namespace configuration");
      args.push("--namespace-id", namespaceId);
    }
    const result = spawnSync("npx", args, { cwd: new URL("../", import.meta.url), env: process.env, encoding: "utf8" });
    if (result.status !== 0) throw new Error("KV write failed");
  } finally {
    await rm(temporaryFile, { force: true });
  }
}

const source = (argument("--source") ?? "local") as Source;
const dryRun = process.argv.includes("--dry-run");

try {
  if (source !== "local" && source !== "env") throw new Error("invalid source");
  const result = await buildFromUpstream(await upstreamUrl(source));
  printSummary(result);
  if (dryRun) console.log("SNAPSHOT_READY=PASS");
  else {
    await publishSnapshot({ put: (key, value) => writeRemoteSnapshot(key, value, source) }, result.snapshot);
    console.log("KV_WRITE=PASS");
  }
} catch (error) {
  const reason = error instanceof UpstreamError || error instanceof SnapshotValidationError
    ? error.reason
    : "publisher_error";
  console.log(`UPSTREAM_DIAGNOSTIC=${reason}`);
  process.exitCode = 1;
}
