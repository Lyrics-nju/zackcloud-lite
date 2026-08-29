import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  readStagingFriendToken,
  resolveStagingFriendsFile,
  resolveStagingUrl,
  resolveTestProxy,
  StagingConfigError,
} from "../scripts/lib/staging-verification";

const workflowText = readFileSync(new URL("../.github/workflows/update-subscription.yml", import.meta.url), "utf8");
const workflow = parse(workflowText) as {
  permissions?: Record<string, string>;
  on?: { schedule?: Array<{ cron?: string }> };
  jobs?: { update?: { steps?: Array<Record<string, unknown>> } };
};

describe("staging verification configuration", () => {
  it("reports a clear code when STAGING_URL is absent", () => {
    try {
      resolveStagingUrl(undefined);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(StagingConfigError);
      expect((error as StagingConfigError).code).toBe("STAGING_URL_NOT_CONFIGURED");
    }
  });

  it.each(["not-a-url", "http://zackcloud-lite-staging.example.workers.dev/", "https://other.example.workers.dev/"])(
    "rejects unsafe staging URL %s",
    (value) => expect(() => resolveStagingUrl(value)).toThrowError("STAGING_URL_INVALID"),
  );

  it("accepts only the staging workers.dev target shape", () => {
    expect(resolveStagingUrl("https://zackcloud-lite-staging.example.workers.dev/").hostname)
      .toBe("zackcloud-lite-staging.example.workers.dev");
  });

  it("prefers the dedicated test proxy", () => {
    expect(resolveTestProxy({
      ZACKCLOUD_TEST_PROXY: "http://proxy.example.invalid:8080",
      HTTPS_PROXY: "http://ignored.example.invalid:8080",
      HTTP_PROXY: "http://ignored-too.example.invalid:8080",
    })).toBe("http://proxy.example.invalid:8080/");
  });

  it("falls back from HTTPS_PROXY to HTTP_PROXY", () => {
    expect(resolveTestProxy({ HTTPS_PROXY: "http://secure.example.invalid:8080", HTTP_PROXY: "http://plain.example.invalid:8080" }))
      .toBe("http://secure.example.invalid:8080/");
    expect(resolveTestProxy({ HTTP_PROXY: "http://plain.example.invalid:8080" })).toBe("http://plain.example.invalid:8080/");
  });

  it("allows direct requests when no proxy is configured", () => {
    expect(resolveTestProxy({})).toBeUndefined();
  });

  it.each(["socks5://proxy.example.invalid:1080", "http://user:pass@proxy.example.invalid"])(
    "rejects unsafe proxy configuration",
    (value) => expect(() => resolveTestProxy({ ZACKCLOUD_TEST_PROXY: value })).toThrowError("TEST_PROXY_INVALID"),
  );

  it("uses the protected staging friend file by default and allows an override", () => {
    expect(resolveStagingFriendsFile({}, "/safe-home"))
      .toBe(join("/safe-home", ".local", "share", "zackcloud-lite", "staging-friends.json"));
    expect(resolveStagingFriendsFile({ ZACKCLOUD_STAGING_FRIENDS_FILE: "/safe/custom.json" }, "/safe-home"))
      .toBe("/safe/custom.json");
  });
});

describe("staging friend token file", () => {
  async function withFile(contents: string, callback: (path: string) => Promise<void>): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "zackcloud-lite-test-"));
    const path = join(directory, "friends.json");
    try {
      await writeFile(path, contents, "utf8");
      await callback(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  it("rejects a missing file with the safe error code", async () => {
    await expect(readStagingFriendToken(join(tmpdir(), "zackcloud-lite-file-does-not-exist.json")))
      .rejects.toThrowError("STAGING_FRIEND_TOKEN_NOT_AVAILABLE");
  });

  it.each([
    ["invalid JSON", "{"],
    ["a non-array document", "{}"],
    ["an empty array", "[]"],
    ["a disabled friend", JSON.stringify([{ token: "disabled-example", enabled: false, expiresAt: null }])],
    ["an expired friend", JSON.stringify([{ token: "expired-example", enabled: true, expiresAt: "2020-01-01T00:00:00Z" }])],
  ])("rejects %s", async (_name, contents) => {
    await withFile(contents, async (path) => {
      await expect(readStagingFriendToken(path, Date.parse("2026-01-01T00:00:00Z")))
        .rejects.toThrowError("STAGING_FRIEND_TOKEN_NOT_AVAILABLE");
    });
  });

  it("returns an enabled, unexpired friend token", async () => {
    await withFile(JSON.stringify([
      { token: "valid-example", enabled: true, expiresAt: "2027-01-01T00:00:00Z" },
    ]), async (path) => {
      await expect(readStagingFriendToken(path, Date.parse("2026-01-01T00:00:00Z"))).resolves.toBe("valid-example");
    });
  });

  it("selects a specifically named staging friend without exposing other tokens", async () => {
    await withFile(JSON.stringify([
      { name: "someone-else", token: "other-valid-example", enabled: true, expiresAt: null },
      { name: "owner-staging", token: "owner-valid-example", enabled: true, expiresAt: null },
    ]), async (path) => {
      await expect(readStagingFriendToken(path, Date.parse("2026-01-01T00:00:00Z"), "owner-staging"))
        .resolves.toBe("owner-valid-example");
    });
  });

  it("returns only the safe unavailable code when a named friend is absent", async () => {
    const sensitiveExample = "not-the-selected-token-example";
    await withFile(JSON.stringify([
      { name: "someone-else", token: sensitiveExample, enabled: true, expiresAt: null },
    ]), async (path) => {
      try {
        await readStagingFriendToken(path, Date.now(), "owner-staging");
        throw new Error("expected failure");
      } catch (error) {
        expect(String(error)).toContain("STAGING_FRIEND_TOKEN_NOT_AVAILABLE");
        expect(String(error)).not.toContain(sensitiveExample);
      }
    });
  });

  it("never includes a token in an error", async () => {
    const sensitiveExample = "never-print-this-example";
    await withFile(JSON.stringify([{ token: sensitiveExample, enabled: false, expiresAt: null }]), async (path) => {
      try {
        await readStagingFriendToken(path);
        throw new Error("expected failure");
      } catch (error) {
        expect(String(error)).toContain("STAGING_FRIEND_TOKEN_NOT_AVAILABLE");
        expect(String(error)).not.toContain(sensitiveExample);
      }
    });
  });
});

describe("GitHub updater workflow audit", () => {
  it("uses the exact four approved secret names", () => {
    const names = [...workflowText.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]).sort();
    expect(names).toEqual([
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_KV_NAMESPACE_ID",
      "UPSTREAM_SUBSCRIPTION_URL",
    ]);
  });

  it("uses minimum repository permissions", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("uses the stable Node 24 action runtimes", () => {
    const uses = workflow.jobs?.update?.steps?.map((step) => String(step.uses ?? "")) ?? [];
    expect(uses).toContain("actions/checkout@v5");
    expect(uses).toContain("actions/setup-node@v5");
  });

  it("runs on a six-hour cron rather than a high-frequency schedule", () => {
    expect(workflow.on?.schedule).toEqual([{ cron: "17 */6 * * *" }]);
  });

  it.each([/set\s+-x/, /echo[^\n]*secrets\./i, /GITHUB_STEP_SUMMARY/, /actions\/upload-artifact/i])(
    "does not contain forbidden workflow behavior %s",
    (pattern) => expect(workflowText).not.toMatch(pattern),
  );

  it("always cleans publisher files from RUNNER_TEMP", () => {
    const cleanup = workflow.jobs?.update?.steps?.find((step) => step.name === "Remove temporary snapshot files");
    expect(cleanup?.if).toBe("always()");
    expect(cleanup?.run).toContain("RUNNER_TEMP");
    expect(cleanup?.run).toContain("zackcloud-lite-snapshot-*.json");
  });

  it("runs validation gates before the KV publisher", () => {
    const commands = workflow.jobs?.update?.steps?.map((step) => String(step.run ?? "")) ?? [];
    const publishIndex = commands.indexOf("npm run update:ci");
    for (const gate of ["npm test", "npm run typecheck", "npm run lint", "npm run security-scan"]) {
      expect(commands.indexOf(gate)).toBeGreaterThan(-1);
      expect(commands.indexOf(gate)).toBeLessThan(publishIndex);
    }
  });

  it("uses the GitHub runner temporary directory in publisher source", () => {
    const publisher = readFileSync(new URL("../scripts/update-subscription.ts", import.meta.url), "utf8");
    expect(publisher).toContain("process.env.RUNNER_TEMP");
    expect(publisher.indexOf("buildFromUpstream")).toBeLessThan(publisher.indexOf("publishSnapshot"));
  });

  it("contains a Linux workerd optional package in the lockfile", () => {
    const lockfile = readFileSync(new URL("../package-lock.json", import.meta.url), "utf8");
    expect(lockfile).toContain("node_modules/@cloudflare/workerd-linux-64");
  });

  it("does not read .dev.vars during security scanning", () => {
    const scanner = readFileSync(new URL("../scripts/security-scan.mjs", import.meta.url), "utf8");
    expect(scanner).not.toContain('readFile(new URL("../.dev.vars"');
  });

  it("only exempts public D1 database IDs in Wrangler config from UUID scanning", () => {
    const scanner = readFileSync(new URL("../scripts/security-scan.mjs", import.meta.url), "utf8");
    expect(scanner).toContain("wrangler\\.jsonc(?:\\.bak)?$");
    expect(scanner).toContain('("database_id"\\s*:\\s*")');
    expect(scanner).toContain("[PUBLIC_D1_DATABASE_ID]");
  });
});
