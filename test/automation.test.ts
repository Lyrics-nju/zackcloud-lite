import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { resolveStagingUrl, resolveTestProxy, StagingConfigError } from "../scripts/lib/staging-verification";

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
});
