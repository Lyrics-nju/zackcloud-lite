import { parse, stringify } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { clashConverter } from "../src/converter/clash";
import { buildFromUpstream, publishSnapshot } from "../src/publisher";
import {
  buildSnapshot,
  parseSnapshot,
  SNAPSHOT_KEY,
  SnapshotValidationError,
  validateConvertedYaml,
  validateSnapshotShape,
} from "../src/snapshot";
import { UpstreamError } from "../src/upstream";
import { clashYaml } from "./fixtures";

describe("snapshot construction and validation", () => {
  it("builds a schema v1 snapshot", async () => {
    const result = await buildSnapshot(clashYaml, new Headers(), new Date("2026-01-02T03:04:05Z"));
    expect(result.snapshot.schemaVersion).toBe(1);
    expect(result.snapshot.generatedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(result.snapshot.proxyCount).toBe(3);
    expect(result.snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces all required validation PASS results", async () => {
    const { summary } = await buildSnapshot(clashYaml);
    expect(summary).toMatchObject({
      proxyCount: 3,
      nonNameFieldsIdentical: true,
      uniqueNames: true,
      groupReferenceCheck: true,
    });
  });

  it("collects safe region and type aggregates", async () => {
    const { summary } = await buildSnapshot(clashYaml);
    expect(summary.regionCounts).toEqual({ 香港: 1, 日本: 1, 英国: 1 });
    expect(summary.typeCounts).toEqual({ ss: 1, trojan: 1, vless: 1 });
  });

  it("stores only whitelisted metadata", async () => {
    const headers = new Headers({
      "subscription-userinfo": "safe-userinfo",
      "profile-update-interval": "12",
      "profile-web-page-url": "https://blocked.example.invalid",
      "set-cookie": "blocked=fake",
      server: "blocked-server",
    });
    const { snapshot } = await buildSnapshot(clashYaml, headers);
    expect(snapshot.metadata).toEqual({
      "subscription-userinfo": "safe-userinfo",
      "profile-update-interval": "12",
    });
  });

  it("allows absent metadata", async () => {
    expect((await buildSnapshot(clashYaml)).snapshot.metadata).toEqual({});
  });

  it.each(["", "garbage", "ss://fake"])("rejects unsupported source format", async (input) => {
    await expect(buildSnapshot(input)).rejects.toMatchObject({ reason: "unsupported_format" });
  });

  it("detects any changed non-name proxy field", () => {
    const document = parse(clashConverter.convert(clashYaml));
    document.proxies[0].port = 1;
    expect(() => validateConvertedYaml(clashYaml, stringify(document))).toThrowError(SnapshotValidationError);
    try {
      validateConvertedYaml(clashYaml, stringify(document));
    } catch (error) {
      expect((error as SnapshotValidationError).reason).toBe("proxy_fields_changed");
    }
  });

  it("detects duplicate names", () => {
    const document = parse(clashConverter.convert(clashYaml));
    document.proxies[1].name = document.proxies[0].name;
    expect(() => validateConvertedYaml(clashYaml, stringify(document))).toThrowError("snapshot validation failed");
  });

  it("detects dangling group references", () => {
    const document = parse(clashConverter.convert(clashYaml));
    document["proxy-groups"][0].proxies.push("missing-reference");
    try {
      validateConvertedYaml(clashYaml, stringify(document));
      throw new Error("expected validation failure");
    } catch (error) {
      expect((error as SnapshotValidationError).reason).toBe("group_reference_invalid");
    }
  });

  it("parses and verifies a valid serialized snapshot", async () => {
    const snapshot = (await buildSnapshot(clashYaml)).snapshot;
    expect(await parseSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(validateSnapshotShape(snapshot)).toBe(true);
  });

  it.each([
    null,
    "not-json",
    JSON.stringify({ schemaVersion: 2 }),
    JSON.stringify({ schemaVersion: 1, yaml: "" }),
  ])("returns null for invalid stored snapshots", async (value) => {
    expect(await parseSnapshot(value)).toBeNull();
  });

  it("rejects a hash mismatch", async () => {
    const snapshot = (await buildSnapshot(clashYaml)).snapshot;
    snapshot.yaml += "\n# changed";
    expect(await parseSnapshot(JSON.stringify(snapshot))).toBeNull();
  });

  it("rejects unsafe metadata keys", async () => {
    const snapshot = (await buildSnapshot(clashYaml)).snapshot;
    const unsafe = { ...snapshot, metadata: { location: "blocked" } };
    expect(validateSnapshotShape(unsafe)).toBe(false);
  });
});

describe("publisher last-known-good behavior", () => {
  it("writes a fully valid snapshot to current", async () => {
    const snapshot = (await buildSnapshot(clashYaml)).snapshot;
    const writer = { put: vi.fn().mockResolvedValue(undefined) };
    await publishSnapshot(writer, snapshot);
    expect(writer.put).toHaveBeenCalledOnce();
    expect(writer.put).toHaveBeenCalledWith(SNAPSHOT_KEY, JSON.stringify(snapshot));
  });

  it("does not overwrite current when validation fails", async () => {
    const snapshot = (await buildSnapshot(clashYaml)).snapshot;
    snapshot.sha256 = "invalid";
    const writer = { put: vi.fn().mockResolvedValue(undefined) };
    await expect(publishSnapshot(writer, snapshot)).rejects.toThrow("refusing to publish invalid snapshot");
    expect(writer.put).not.toHaveBeenCalled();
  });

  it("build-only dry-run pipeline performs no KV write", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(clashYaml));
    const result = await buildFromUpstream("https://upstream.example.invalid/sub", fetcher);
    expect(result.snapshot.proxyCount).toBe(3);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("preserves safe upstream metadata in the built snapshot", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(clashYaml, {
      headers: { "subscription-userinfo": "safe", "profile-update-interval": "6" },
    }));
    const result = await buildFromUpstream("https://upstream.example.invalid/sub", fetcher);
    expect(result.snapshot.metadata).toEqual({ "subscription-userinfo": "safe", "profile-update-interval": "6" });
  });

  it("surfaces only safe upstream diagnostics", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private body", { status: 403 }));
    try {
      await buildFromUpstream("https://upstream.example.invalid/sub", fetcher);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).reason).toBe("http_403");
      expect((error as Error).message).toBe("upstream request failed");
      expect((error as Error).message).not.toContain("private body");
    }
  });
});
