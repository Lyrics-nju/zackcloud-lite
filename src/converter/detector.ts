import { parse } from "yaml";

export type SubscriptionFormat =
  | "CLASH_YAML"
  | "BASE64_URI_LIST"
  | "PLAIN_URI_LIST"
  | "SINGBOX_JSON"
  | "YAML_PAYLOAD"
  | "UNKNOWN";

const URI_PATTERN = /^(ss|trojan|vmess|vless|hysteria2?|hy2|tuic|socks5?|http):\/\//i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uriLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function isUriList(value: string): boolean {
  const lines = uriLines(value);
  return lines.length > 0 && lines.every((line) => URI_PATTERN.test(line));
}

export function decodeBase64UriList(input: string): string | null {
  const compact = input.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!compact || /[^A-Za-z0-9+/=]/.test(compact)) return null;
  try {
    const decoded = Uint8Array.from(atob(compact), (character) => character.charCodeAt(0));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    return isUriList(text) ? text : null;
  } catch {
    return null;
  }
}

export function detectSubscriptionFormat(input: string): SubscriptionFormat {
  const trimmed = input.trim();
  if (!trimmed) return "UNKNOWN";

  try {
    const json: unknown = JSON.parse(trimmed);
    if (isRecord(json) && Array.isArray(json.outbounds)) return "SINGBOX_JSON";
  } catch {
    // Continue with text and YAML detection.
  }

  if (isUriList(trimmed)) return "PLAIN_URI_LIST";
  if (decodeBase64UriList(trimmed) !== null) return "BASE64_URI_LIST";

  try {
    const yaml: unknown = parse(trimmed);
    if (isRecord(yaml) && Array.isArray(yaml.proxies) && yaml.proxies.length > 0) return "CLASH_YAML";
    if (isRecord(yaml) && Array.isArray(yaml.payload)) return "YAML_PAYLOAD";
  } catch {
    // Not safely recognizable YAML.
  }

  return "UNKNOWN";
}

export function summarizeProtocols(input: string, format: SubscriptionFormat): { nodeCount: number; protocolCounts: Record<string, number> } {
  const counts: Record<string, number> = {};
  const add = (type: unknown) => {
    if (typeof type !== "string" || !type) return;
    const key = type.toLowerCase();
    counts[key] = (counts[key] ?? 0) + 1;
  };

  if (format === "CLASH_YAML") {
    const document = parse(input) as { proxies?: Array<{ type?: unknown }> };
    const proxies = Array.isArray(document.proxies) ? document.proxies : [];
    proxies.forEach((proxy) => add(proxy.type));
    return { nodeCount: proxies.length, protocolCounts: counts };
  }

  if (format === "PLAIN_URI_LIST" || format === "BASE64_URI_LIST") {
    const text = format === "BASE64_URI_LIST" ? decodeBase64UriList(input) ?? "" : input;
    const lines = uriLines(text);
    lines.forEach((line) => add(/^([a-z0-9]+):\/\//i.exec(line)?.[1]));
    return { nodeCount: lines.length, protocolCounts: counts };
  }

  if (format === "SINGBOX_JSON") {
    const document = JSON.parse(input) as { outbounds?: Array<{ type?: unknown }> };
    const outbounds = Array.isArray(document.outbounds) ? document.outbounds : [];
    outbounds.forEach((outbound) => add(outbound.type));
    return { nodeCount: outbounds.length, protocolCounts: counts };
  }

  return { nodeCount: 0, protocolCounts: counts };
}
