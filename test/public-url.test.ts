import { describe, expect, it } from "vitest";
import { addFriend, rotateFriend } from "../scripts/lib/friend-store";
import {
  DEFAULT_PUBLIC_BASE_URL,
  friendSubscriptionUrl,
  resolvePublicBaseUrl,
} from "../scripts/lib/public-subscription-url";
import {
  customDomainVerificationLines,
  resolveCustomDomainUrl,
} from "../scripts/lib/staging-verification";

const EXAMPLE_TOKEN = "example-token-value-cccccccccccc";
const ROTATED_TOKEN = "example-token-value-dddddddddddd";
const NOW = Date.parse("2026-08-29T00:00:00Z");

describe("public subscription URL", () => {
  it("uses the formal custom domain by default", () => {
    expect(DEFAULT_PUBLIC_BASE_URL).toBe("https://sub.zackcloud.site");
    expect(resolvePublicBaseUrl(undefined).href).toBe("https://sub.zackcloud.site/");
  });

  it("allows an explicit environment override", () => {
    expect(resolvePublicBaseUrl("https://example.invalid/friends").href)
      .toBe("https://example.invalid/friends/");
  });

  it("normalizes repeated and trailing path separators", () => {
    expect(resolvePublicBaseUrl("https://example.invalid///friends///").pathname).toBe("/friends/");
  });

  it("never creates duplicate slashes in the subscription path", () => {
    const url = new URL(friendSubscriptionUrl(EXAMPLE_TOKEN, { ZACKCLOUD_PUBLIC_BASE_URL: "https://example.invalid///" }));
    expect(url.pathname).toBe(`/sub/${EXAMPLE_TOKEN}`);
    expect(url.pathname).not.toContain("//");
  });

  it("creates the friend:add subscription URL from the default", () => {
    const added = addFriend([], "Alice", NOW, () => EXAMPLE_TOKEN);
    expect(friendSubscriptionUrl(added.friend.token, {}))
      .toBe(`https://sub.zackcloud.site/sub/${EXAMPLE_TOKEN}`);
  });

  it("creates the friend:rotate subscription URL from the default", () => {
    const added = addFriend([], "Alice", NOW, () => EXAMPLE_TOKEN);
    const rotated = rotateFriend(added.friends, "Alice", NOW + 1_000, () => ROTATED_TOKEN);
    expect(friendSubscriptionUrl(rotated.friend.token, {}))
      .toBe(`https://sub.zackcloud.site/sub/${ROTATED_TOKEN}`);
  });

  it("does not use workers.dev as the default", () => {
    expect(new URL(DEFAULT_PUBLIC_BASE_URL).hostname).not.toMatch(/\.workers\.dev$/);
    expect(friendSubscriptionUrl(EXAMPLE_TOKEN, {})).not.toContain("workers.dev");
  });
});

describe("custom-domain verification safety", () => {
  it("accepts only the formal custom-domain root", () => {
    expect(resolveCustomDomainUrl("https://sub.zackcloud.site")?.href).toBe("https://sub.zackcloud.site/");
    expect(() => resolveCustomDomainUrl("https://example.invalid")).toThrowError("CUSTOM_DOMAIN_URL_INVALID");
  });

  it("redacts token and URL details from verification output", () => {
    const output = customDomainVerificationLines({ health: 200, subscription: 200, etagPass: true }).join("\n");
    expect(output).toBe([
      "CUSTOM_DOMAIN_HEALTH=200",
      "CUSTOM_DOMAIN_SUBSCRIPTION=200",
      "CUSTOM_DOMAIN_ETAG=PASS",
      "CUSTOM_DOMAIN_VERIFY=PASS",
    ].join("\n"));
    expect(output).not.toContain(EXAMPLE_TOKEN);
    expect(output).not.toContain("/sub/");
  });
});
