import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { clashConverter, classifyRegion } from "../src/converter/clash";
import { clashYaml } from "./fixtures";

const regionCases: Array<[string, string]> = [
  ["HK Premium", "香港"], ["HongKong 01", "香港"], ["🇯🇵 Tokyo", "日本"],
  ["SG-02", "新加坡"], ["United States West", "美国"], ["TW Taipei", "台湾"],
  ["KR Seoul", "韩国"], ["UK London", "英国"], ["DE Frankfurt", "德国"],
  ["FR Paris", "法国"], ["CA Toronto", "加拿大"], ["AU Sydney", "澳大利亚"],
  ["NL Amsterdam", "荷兰"], ["IN Mumbai", "印度"], ["TR Istanbul", "土耳其"],
  ["RU Moscow", "俄罗斯"], ["Moon Base", "其他"],
];

describe("Clash converter", () => {
  it.each(regionCases)("classifies %s as %s", (name, region) => {
    expect(classifyRegion(name).region).toBe(region);
  });

  it("renames nodes with stable, unique regional sequences", () => {
    const input = `proxies:\n  - { name: HK A, type: ss, server: a.invalid }\n  - { name: JP A, type: ss, server: b.invalid }\n  - { name: HK B, type: ss, server: c.invalid }\n`;
    const output = parse(clashConverter.convert(input));
    const names = output.proxies.map((proxy: { name: string }) => proxy.name);
    expect(names).toEqual(["🇭🇰 扎克云 · 香港 01", "🇯🇵 扎克云 · 日本 01", "🇭🇰 扎克云 · 香港 02"]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("preserves every non-name field deeply", () => {
    const before = parse(clashYaml).proxies;
    const after = parse(clashConverter.convert(clashYaml)).proxies;
    expect(after).toHaveLength(before.length);
    for (let index = 0; index < before.length; index += 1) {
      const beforeFields = structuredClone(before[index]);
      const afterFields = structuredClone(after[index]);
      delete beforeFields.name;
      delete afterFields.name;
      expect(afterFields).toEqual(beforeFields);
    }
  });

  it("creates a canonical selector, the three core groups, and only non-empty region groups", () => {
    const output = parse(clashConverter.convert(clashYaml));
    const names = output["proxy-groups"].map((group: { name: string }) => group.name);
    expect(names[0]).toBe("ZackCloud");
    expect(names).toContain("🚀 扎克云 · 自动选择");
    expect(names).toContain("👆 扎克云 · 手动选择");
    expect(names).toContain("♻️ 扎克云 · 故障转移");
    expect(names).toContain("🇭🇰 扎克云 · 香港");
    expect(names).toContain("🇯🇵 扎克云 · 日本");
    expect(names).toContain("🇬🇧 扎克云 · 英国");
    expect(names).not.toContain("🇸🇬 扎克云 · 新加坡");
    const primary = output["proxy-groups"].find((group: { name: string }) => group.name === "ZackCloud");
    const proxyNames = output.proxies.map((proxy: { name: string }) => proxy.name);
    expect(primary.type).toBe("select");
    expect(primary.proxies).toContain("🚀 扎克云 · 自动选择");
    expect(proxyNames.every((name: string) => primary.proxies.includes(name))).toBe(true);
  });

  it("rewrites rules and sub-rules that target removed upstream groups or renamed nodes", () => {
    const input = `proxies:\n  - { name: HK A, type: ss, server: a.invalid }\nproxy-groups:\n  - { name: Upstream Group, type: select, proxies: [HK A] }\nrules:\n  - DOMAIN-SUFFIX,example.invalid,Upstream Group\n  - IP-CIDR,192.0.2.0/24,HK A,no-resolve\n  - MATCH,DIRECT\nsub-rules:\n  local:\n    - DOMAIN,local.invalid,Upstream Group\n`;
    const output = parse(clashConverter.convert(input));
    expect(output.rules).toEqual([
      "DOMAIN-SUFFIX,example.invalid,ZackCloud",
      "IP-CIDR,192.0.2.0/24,🇭🇰 扎克云 · 香港 01,no-resolve",
      "MATCH,DIRECT",
    ]);
    expect(output["sub-rules"].local).toEqual(["DOMAIN,local.invalid,ZackCloud"]);
  });

  it("has no dangling group references", () => {
    const output = parse(clashConverter.convert(clashYaml));
    const valid = new Set<string>([
      ...output.proxies.map((proxy: { name: string }) => proxy.name),
      ...output["proxy-groups"].map((group: { name: string }) => group.name),
      "DIRECT",
      "REJECT",
    ]);
    for (const group of output["proxy-groups"] as Array<{ proxies: string[] }>) {
      expect(group.proxies.every((reference) => valid.has(reference))).toBe(true);
    }
  });
});
