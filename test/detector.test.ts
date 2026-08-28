import { describe, expect, it } from "vitest";
import { detectSubscriptionFormat } from "../src/converter/detector";
import { clashYaml } from "./fixtures";

describe("subscription detector", () => {
  it("detects Clash YAML", () => expect(detectSubscriptionFormat(clashYaml)).toBe("CLASH_YAML"));
  it("detects a plain URI list", () => expect(detectSubscriptionFormat("ss://fake-a\ntrojan://fake-b")).toBe("PLAIN_URI_LIST"));
  it("detects a Base64 URI list", () => {
    const encoded = btoa("vless://fake-a\nhysteria2://fake-b");
    expect(detectSubscriptionFormat(encoded)).toBe("BASE64_URI_LIST");
  });
  it("detects sing-box JSON", () => expect(detectSubscriptionFormat('{"outbounds":[{"type":"direct"}]}')).toBe("SINGBOX_JSON"));
  it("detects YAML payload", () => expect(detectSubscriptionFormat("payload:\n  - fake-value")).toBe("YAML_PAYLOAD"));
  it.each(["", "<html></html>", "garbage"])("returns UNKNOWN for unsupported input", (input) => {
    expect(detectSubscriptionFormat(input)).toBe("UNKNOWN");
  });
});
