import { parse, stringify } from "yaml";
import type { SubscriptionConverter } from "./types";

type ProxyNode = Record<string, unknown> & { name: string };
type Region = "香港" | "日本" | "新加坡" | "美国" | "台湾" | "韩国" | "其他";

const REGION_RULES: ReadonlyArray<{
  region: Region;
  flag: string;
  pattern: RegExp;
}> = [
  { region: "香港", flag: "🇭🇰", pattern: /香港|港|hong\s*kong|\bhk\b/i },
  { region: "日本", flag: "🇯🇵", pattern: /日本|东京|大阪|japan|tokyo|osaka|\bjp\b/i },
  { region: "新加坡", flag: "🇸🇬", pattern: /新加坡|狮城|singapore|\bsg\b/i },
  { region: "美国", flag: "🇺🇸", pattern: /美国|美西|美东|洛杉矶|西雅图|圣何塞|达拉斯|纽约|united\s*states|los\s*angeles|seattle|san\s*jose|\bus\b|\busa\b/i },
  { region: "台湾", flag: "🇹🇼", pattern: /台湾|台北|新北|taiwan|taipei|\btw\b/i },
  { region: "韩国", flag: "🇰🇷", pattern: /韩国|首尔|南韩|korea|seoul|\bkr\b/i },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classify(name: string): { region: Region; flag: string } {
  return REGION_RULES.find(({ pattern }) => pattern.test(name)) ?? { region: "其他", flag: "🌐" };
}

function isProxyNode(value: unknown): value is ProxyNode {
  return isRecord(value) && typeof value.name === "string" && value.name.trim() !== "" &&
    typeof value.type === "string" && typeof value.server === "string";
}

export const clashConverter: SubscriptionConverter = {
  id: "clash-yaml",

  canConvert(input) {
    try {
      const document: unknown = parse(input);
      return isRecord(document) && Array.isArray(document.proxies) &&
        document.proxies.length > 0 && document.proxies.every(isProxyNode);
    } catch {
      return false;
    }
  },

  convert(input) {
    const document: unknown = parse(input);
    if (!isRecord(document) || !Array.isArray(document.proxies) ||
        document.proxies.length === 0 || !document.proxies.every(isProxyNode)) {
      throw new Error("无效的 Clash/Mihomo YAML");
    }

    const counts = new Map<Region, number>();
    const byRegion = new Map<Region, string[]>();
    const renamed = document.proxies.map((proxy) => {
      const { region, flag } = classify(proxy.name);
      const sequence = (counts.get(region) ?? 0) + 1;
      counts.set(region, sequence);
      const name = `${flag} 扎克云 · ${region} ${String(sequence).padStart(2, "0")}`;
      byRegion.set(region, [...(byRegion.get(region) ?? []), name]);
      return { ...proxy, name };
    });

    const allNames = renamed.map(({ name }) => name);
    const automatic = "🚀 扎克云 · 自动选择";
    const manual = "👆 扎克云 · 手动选择";
    document.proxies = renamed;
    document["proxy-groups"] = [
      { name: automatic, type: "url-test", proxies: allNames, url: "https://www.gstatic.com/generate_204", interval: 300 },
      { name: manual, type: "select", proxies: [automatic, ...allNames] },
      { name: "🇭🇰 香港优先", type: "select", proxies: [...(byRegion.get("香港") ?? []), automatic] },
      { name: "🇯🇵 日本优先", type: "select", proxies: [...(byRegion.get("日本") ?? []), automatic] },
    ];

    return stringify(document, { lineWidth: 0 });
  },
};
