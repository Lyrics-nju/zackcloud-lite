import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { clashConverter } from "../src/converter/clash.ts";
import { detectSubscriptionFormat } from "../src/converter/detector.ts";
import { fetchUpstream, UPSTREAM_USER_AGENT } from "../src/upstream.ts";

function parseDevVars(text) {
  const values = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

function withoutName(proxy) {
  const copy = structuredClone(proxy);
  delete copy.name;
  return copy;
}

const values = parseDevVars(await readFile(new URL("../.dev.vars", import.meta.url), "utf8"));
const upstreamUrl = values.get("UPSTREAM_SUBSCRIPTION_URL");
if (!upstreamUrl) throw new Error("UPSTREAM_SUBSCRIPTION_URL is not configured");

const upstream = await fetchUpstream(upstreamUrl, fetch);
const response = upstream.response;
const originalText = upstream.body;
const format = detectSubscriptionFormat(originalText);
assert.equal(format, "CLASH_YAML");

const convertedText = clashConverter.convert(originalText);
const original = parse(originalText);
const converted = parse(convertedText);
assert.ok(Array.isArray(original.proxies));
assert.ok(Array.isArray(converted.proxies));
assert.equal(converted.proxies.length, original.proxies.length);

let nonNameFieldsIdentical = true;
for (let index = 0; index < original.proxies.length; index += 1) {
  try {
    assert.deepEqual(withoutName(converted.proxies[index]), withoutName(original.proxies[index]));
  } catch {
    nonNameFieldsIdentical = false;
    break;
  }
}

const names = converted.proxies.map((proxy) => proxy.name);
const uniqueNames = new Set(names).size === names.length;
const groupNames = converted["proxy-groups"].map((group) => group.name);
const validReferences = new Set([...names, ...groupNames]);
const groupReferenceCheck = converted["proxy-groups"].every((group) =>
  Array.isArray(group.proxies) && group.proxies.every((reference) => validReferences.has(reference)));

const regionCounts = {};
const typeCounts = {};
for (const proxy of converted.proxies) {
  const region = /^\S+ 扎克云 · (.+) \d{2,}$/.exec(proxy.name)?.[1] ?? "其他";
  regionCounts[region] = (regionCounts[region] ?? 0) + 1;
  const type = String(proxy.type).toLowerCase();
  typeCounts[type] = (typeCounts[type] ?? 0) + 1;
}

assert.equal(nonNameFieldsIdentical, true);
assert.equal(uniqueNames, true);
assert.equal(groupReferenceCheck, true);

const safeDirectory = join(homedir(), ".local", "share", "zackcloud-lite");
const safeFile = join(safeDirectory, "last-success.yaml");
await mkdir(safeDirectory, { recursive: true });
await writeFile(safeFile, convertedText, { encoding: "utf8", mode: 0o600 });
await chmod(safeFile, 0o600);

const metadata = ["subscription-userinfo", "profile-update-interval"]
  .filter((name) => response.headers.has(name));

console.log(`REAL_UPSTREAM_FORMAT=${format}`);
console.log(`REAL_UPSTREAM_USER_AGENT=${UPSTREAM_USER_AGENT}`);
console.log(`REAL_PROXY_COUNT=${converted.proxies.length}`);
console.log(`REGION_COUNTS=${JSON.stringify(regionCounts)}`);
console.log(`TYPE_COUNTS=${JSON.stringify(typeCounts)}`);
console.log(`NON_NAME_FIELDS_IDENTICAL=${nonNameFieldsIdentical ? "PASS" : "FAIL"}`);
console.log(`UNIQUE_NAMES=${uniqueNames ? "PASS" : "FAIL"}`);
console.log(`GROUP_REFERENCE_CHECK=${groupReferenceCheck ? "PASS" : "FAIL"}`);
console.log(`SUBSCRIPTION_METADATA_FORWARDING=${metadata.length > 0 ? metadata.join(",") : "NONE_AVAILABLE"}`);
