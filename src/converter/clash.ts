import { parse, stringify } from "yaml";
import type { SubscriptionConverter } from "./types";

type ProxyNode = Record<string, unknown> & { name: string };
export type Region = "香港" | "日本" | "新加坡" | "美国" | "台湾" | "韩国" | "英国" | "德国" | "法国" | "加拿大" | "澳大利亚" | "荷兰" | "印度" | "土耳其" | "俄罗斯" | "其他";

const REGION_RULES: ReadonlyArray<{
  region: Region;
  flag: string;
  pattern: RegExp;
}> = [
  { region: "香港", flag: "🇭🇰", pattern: /🇭🇰|香港|hong\s*kong|hongkong|\bhk\b/i },
  { region: "日本", flag: "🇯🇵", pattern: /🇯🇵|日本|东京|大阪|japan|tokyo|osaka|\bjp\b/i },
  { region: "新加坡", flag: "🇸🇬", pattern: /🇸🇬|新加坡|狮城|singapore|\bsg\b/i },
  { region: "美国", flag: "🇺🇸", pattern: /🇺🇸|美国|美西|美东|洛杉矶|西雅图|圣何塞|达拉斯|纽约|united\s*states|america|los\s*angeles|seattle|san\s*jose|\bus\b|\busa\b/i },
  { region: "台湾", flag: "🇹🇼", pattern: /🇹🇼|台湾|台北|新北|taiwan|taipei|\btw\b/i },
  { region: "韩国", flag: "🇰🇷", pattern: /🇰🇷|韩国|首尔|南韩|korea|seoul|\bkr\b/i },
  { region: "英国", flag: "🇬🇧", pattern: /🇬🇧|英国|伦敦|united\s*kingdom|britain|london|\buk\b|\bgb\b/i },
  { region: "德国", flag: "🇩🇪", pattern: /🇩🇪|德国|法兰克福|germany|frankfurt|\bde\b/i },
  { region: "法国", flag: "🇫🇷", pattern: /🇫🇷|法国|巴黎|france|paris|\bfr\b/i },
  { region: "加拿大", flag: "🇨🇦", pattern: /🇨🇦|加拿大|多伦多|温哥华|canada|toronto|vancouver|\bca\b/i },
  { region: "澳大利亚", flag: "🇦🇺", pattern: /🇦🇺|澳大利亚|澳洲|悉尼|墨尔本|australia|sydney|melbourne|\bau\b/i },
  { region: "荷兰", flag: "🇳🇱", pattern: /🇳🇱|荷兰|阿姆斯特丹|netherlands|amsterdam|\bnl\b/i },
  { region: "印度", flag: "🇮🇳", pattern: /🇮🇳|印度|孟买|india|mumbai|\bin\b/i },
  { region: "土耳其", flag: "🇹🇷", pattern: /🇹🇷|土耳其|伊斯坦布尔|turkey|türkiye|istanbul|\btr\b/i },
  { region: "俄罗斯", flag: "🇷🇺", pattern: /🇷🇺|俄罗斯|莫斯科|russia|moscow|\bru\b/i },
];

const REGION_GROUPS: ReadonlyArray<{ region: Region; name: string }> = [
  { region: "香港", name: "🇭🇰 扎克云 · 香港" },
  { region: "日本", name: "🇯🇵 扎克云 · 日本" },
  { region: "新加坡", name: "🇸🇬 扎克云 · 新加坡" },
  { region: "美国", name: "🇺🇸 扎克云 · 美国" },
  { region: "台湾", name: "🇹🇼 扎克云 · 台湾" },
  { region: "韩国", name: "🇰🇷 扎克云 · 韩国" },
  { region: "英国", name: "🇬🇧 扎克云 · 英国" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function classifyRegion(name: string): { region: Region; flag: string } {
  return REGION_RULES.find(({ pattern }) => pattern.test(name)) ?? { region: "其他", flag: "🌐" };
}

function isProxyNode(value: unknown): value is ProxyNode {
  return isRecord(value) && typeof value.name === "string" && value.name.trim() !== "" &&
    typeof value.type === "string" && typeof value.server === "string";
}

function rewriteRulePolicy(rule: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (typeof rule !== "string") return rule;
  const parts = rule.split(",");
  const last = parts.length - 1;
  const policyIndex = parts[last]?.trim().toLowerCase() === "no-resolve" ? last - 1 : last;
  if (policyIndex < 0) return rule;
  const policy = parts[policyIndex]?.trim();
  const replacement = policy ? replacements.get(policy) : undefined;
  if (!replacement) return rule;
  parts[policyIndex] = replacement;
  return parts.join(",");
}

function rewriteRuleCollections(document: Record<string, unknown>, replacements: ReadonlyMap<string, string>): void {
  if (Array.isArray(document.rules)) {
    document.rules = document.rules.map((rule) => rewriteRulePolicy(rule, replacements));
  }
  if (isRecord(document["sub-rules"])) {
    for (const [name, rules] of Object.entries(document["sub-rules"])) {
      if (Array.isArray(rules)) document["sub-rules"][name] = rules.map((rule) => rewriteRulePolicy(rule, replacements));
    }
  }
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
    const replacements = new Map<string, string>();
    const renamed = document.proxies.map((proxy) => {
      const { region, flag } = classifyRegion(proxy.name);
      const sequence = (counts.get(region) ?? 0) + 1;
      counts.set(region, sequence);
      const name = `${flag} 扎克云 · ${region} ${String(sequence).padStart(2, "0")}`;
      replacements.set(proxy.name, name);
      byRegion.set(region, [...(byRegion.get(region) ?? []), name]);
      return { ...proxy, name };
    });

    const allNames = renamed.map(({ name }) => name);
    const automatic = "🚀 扎克云 · 自动选择";
    const manual = "👆 扎克云 · 手动选择";
    const fallback = "♻️ 扎克云 · 故障转移";
    const primary = "ZackCloud";
    if (Array.isArray(document["proxy-groups"])) {
      for (const group of document["proxy-groups"]) {
        if (isRecord(group) && typeof group.name === "string") replacements.set(group.name, primary);
      }
    }
    const regionGroups = REGION_GROUPS.flatMap(({ region, name }) => {
      const names = byRegion.get(region) ?? [];
      return names.length > 0 ? [{ name, type: "select", proxies: names }] : [];
    });
    rewriteRuleCollections(document, replacements);
    document.proxies = renamed;
    document["proxy-groups"] = [
      { name: primary, type: "select", proxies: [automatic, fallback, ...regionGroups.map(({ name }) => name), ...allNames, "DIRECT"] },
      { name: automatic, type: "url-test", proxies: allNames, url: "https://www.gstatic.com/generate_204", interval: 300 },
      { name: fallback, type: "fallback", proxies: allNames, url: "https://www.gstatic.com/generate_204", interval: 300 },
      { name: manual, type: "select", proxies: [automatic, fallback, ...regionGroups.map(({ name }) => name), ...allNames] },
      ...regionGroups,
    ];

    return stringify(document, { lineWidth: 0 });
  },
};
