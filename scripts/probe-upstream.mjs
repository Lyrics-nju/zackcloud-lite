import { readFile } from "node:fs/promises";
import { detectSubscriptionFormat, summarizeProtocols } from "../src/converter/detector.ts";

const USER_AGENTS = [
  "mihomo",
  "clash.meta",
  "ClashforWindows/0.20.39",
  "ClashMetaForAndroid",
  "sing-box",
  "ZackCloud-Lite/0.2",
];

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

const values = parseDevVars(await readFile(new URL("../.dev.vars", import.meta.url), "utf8"));
const upstreamUrl = values.get("UPSTREAM_SUBSCRIPTION_URL");
if (!upstreamUrl) throw new Error("UPSTREAM_SUBSCRIPTION_URL is not configured");

for (const userAgent of USER_AGENTS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(upstreamUrl, {
      headers: { Accept: "application/yaml, text/yaml, application/json, text/plain", "User-Agent": userAgent },
      signal: controller.signal,
    });
    const body = await response.text();
    const format = detectSubscriptionFormat(body);
    const summary = summarizeProtocols(body, format);
    console.log(JSON.stringify({
      userAgent,
      status: response.status,
      contentType: response.headers.get("content-type")?.split(";")[0] ?? null,
      responseBytes: new TextEncoder().encode(body).byteLength,
      format,
      nodeCount: summary.nodeCount,
      protocolCounts: summary.protocolCounts,
      headerNames: [...response.headers.keys()].sort(),
    }));
  } catch {
    console.log(JSON.stringify({ userAgent, status: "FETCH_FAILED", contentType: null, responseBytes: 0, format: "UNKNOWN", nodeCount: 0, protocolCounts: {}, headerNames: [] }));
  } finally {
    clearTimeout(timeout);
  }
}
