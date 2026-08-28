import { parse } from "yaml";
import { clashConverter, classifyRegion } from "./converter/clash";
import { detectSubscriptionFormat } from "./converter/detector";
import { sha256Hex } from "./hash";

export const SNAPSHOT_KEY = "subscription:current";
export const SNAPSHOT_SCHEMA_VERSION = 1;

export interface SnapshotMetadata {
  "subscription-userinfo"?: string;
  "profile-update-interval"?: string;
}

export interface SubscriptionSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  sha256: string;
  proxyCount: number;
  yaml: string;
  metadata: SnapshotMetadata;
}

export interface ValidationSummary {
  proxyCount: number;
  regionCounts: Record<string, number>;
  typeCounts: Record<string, number>;
  nonNameFieldsIdentical: boolean;
  uniqueNames: boolean;
  groupReferenceCheck: boolean;
}

export interface BuiltSnapshot {
  format: "CLASH_YAML";
  snapshot: SubscriptionSnapshot;
  summary: ValidationSummary;
}

export class SnapshotValidationError extends Error {
  constructor(readonly reason: string) {
    super("snapshot validation failed");
    this.name = "SnapshotValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
      key === rightKeys[index] && deepEqual(left[key], right[key]));
  }
  return false;
}

function withoutName(value: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(value);
  delete copy.name;
  return copy;
}

function safeMetadata(headers: Headers): SnapshotMetadata {
  const metadata: SnapshotMetadata = {};
  for (const name of ["subscription-userinfo", "profile-update-interval"] as const) {
    const value = headers.get(name);
    if (value !== null) metadata[name] = value;
  }
  return metadata;
}

export function validateConvertedYaml(originalYaml: string, convertedYaml: string): ValidationSummary {
  let original: unknown;
  let converted: unknown;
  try {
    original = parse(originalYaml);
    converted = parse(convertedYaml);
  } catch {
    throw new SnapshotValidationError("yaml_parse_failed");
  }
  if (!isRecord(original) || !isRecord(converted) || !Array.isArray(original.proxies) ||
      !Array.isArray(converted.proxies) || original.proxies.length === 0 ||
      original.proxies.length !== converted.proxies.length ||
      !original.proxies.every(isRecord) || !converted.proxies.every(isRecord)) {
    throw new SnapshotValidationError("proxy_count_invalid");
  }

  const originalProxies = original.proxies;
  const convertedProxies = converted.proxies;
  const nonNameFieldsIdentical = originalProxies.every((proxy, index) =>
    deepEqual(withoutName(proxy), withoutName(convertedProxies[index])));
  const names = convertedProxies.map((proxy) => proxy.name).filter((name): name is string => typeof name === "string");
  const uniqueNames = names.length === convertedProxies.length && new Set(names).size === names.length;
  const groups = Array.isArray(converted["proxy-groups"]) ? converted["proxy-groups"].filter(isRecord) : [];
  const groupNames = groups.map((group) => group.name).filter((name): name is string => typeof name === "string");
  const references = new Set([...names, ...groupNames]);
  const groupReferenceCheck = groups.length > 0 && groups.every((group) =>
    Array.isArray(group.proxies) && group.proxies.every((reference) => typeof reference === "string" && references.has(reference)));

  if (!nonNameFieldsIdentical) throw new SnapshotValidationError("proxy_fields_changed");
  if (!uniqueNames) throw new SnapshotValidationError("proxy_names_invalid");
  if (!groupReferenceCheck) throw new SnapshotValidationError("group_reference_invalid");

  const regionCounts: Record<string, number> = {};
  const typeCounts: Record<string, number> = {};
  for (const proxy of originalProxies) {
    const region = classifyRegion(typeof proxy.name === "string" ? proxy.name : "").region;
    regionCounts[region] = (regionCounts[region] ?? 0) + 1;
    const type = typeof proxy.type === "string" ? proxy.type.toLowerCase() : "unknown";
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
  }

  return {
    proxyCount: convertedProxies.length,
    regionCounts,
    typeCounts,
    nonNameFieldsIdentical,
    uniqueNames,
    groupReferenceCheck,
  };
}

export async function buildSnapshot(originalYaml: string, upstreamHeaders = new Headers(), now = new Date()): Promise<BuiltSnapshot> {
  if (detectSubscriptionFormat(originalYaml) !== "CLASH_YAML") throw new SnapshotValidationError("unsupported_format");
  const convertedYaml = clashConverter.convert(originalYaml);
  const summary = validateConvertedYaml(originalYaml, convertedYaml);
  const snapshot: SubscriptionSnapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    sha256: await sha256Hex(convertedYaml),
    proxyCount: summary.proxyCount,
    yaml: convertedYaml,
    metadata: safeMetadata(upstreamHeaders),
  };
  return { format: "CLASH_YAML", snapshot, summary };
}

function hasOnlyMetadataKeys(metadata: Record<string, unknown>): boolean {
  return Object.keys(metadata).every((key) => key === "subscription-userinfo" || key === "profile-update-interval") &&
    Object.values(metadata).every((value) => typeof value === "string");
}

export function validateSnapshotShape(value: unknown): value is SubscriptionSnapshot {
  if (!isRecord(value) || value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
      typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt)) ||
      typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !Number.isInteger(value.proxyCount) || (value.proxyCount as number) <= 0 ||
      typeof value.yaml !== "string" || value.yaml.trim() === "" || !isRecord(value.metadata) ||
      !hasOnlyMetadataKeys(value.metadata)) return false;
  try {
    const yaml: unknown = parse(value.yaml);
    return isRecord(yaml) && Array.isArray(yaml.proxies) && yaml.proxies.length === value.proxyCount;
  } catch {
    return false;
  }
}

export async function parseSnapshot(value: string | null): Promise<SubscriptionSnapshot | null> {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!validateSnapshotShape(parsed)) return null;
    return await sha256Hex(parsed.yaml) === parsed.sha256 ? parsed : null;
  } catch {
    return null;
  }
}
