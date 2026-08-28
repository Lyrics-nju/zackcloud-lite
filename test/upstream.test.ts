import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUpstream, UPSTREAM_MAX_BYTES, UpstreamError } from "../src/upstream";

const fakeUrl = "https://upstream.example.invalid/sub";

afterEach(() => vi.useRealTimers());

async function expectReason(promise: Promise<unknown>, reason: string) {
  await expect(promise).rejects.toMatchObject({
    name: "UpstreamError",
    reason,
    message: "upstream request failed",
  });
}

describe("safe upstream failure reasons", () => {
  it("reports missing_config", async () => {
    await expectReason(fetchUpstream("", vi.fn<typeof fetch>()), "missing_config");
  });

  it.each([
    [403, "http_403"],
    [404, "http_404"],
    [429, "http_429"],
    [500, "http_5xx"],
    [503, "http_5xx"],
  ])("maps HTTP %s to %s", async (status, reason) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private body", { status }));
    await expectReason(fetchUpstream(fakeUrl, fetcher), reason);
  });

  it("reports empty_response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(" \n "));
    await expectReason(fetchUpstream(fakeUrl, fetcher), "empty_response");
  });

  it("reports network_error without retaining exception text", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("hostname and IP must stay private"));
    try {
      await fetchUpstream(fakeUrl, fetcher);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).reason).toBe("network_error");
      expect((error as Error).message).toBe("upstream request failed");
      expect((error as Error).message).not.toContain("hostname");
    }
  });

  it("reports timeout", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("private abort detail", "AbortError")));
    }));
    const pending = fetchUpstream(fakeUrl, fetcher);
    const assertion = expectReason(pending, "timeout");
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("returns a non-empty successful body", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("proxies: []"));
    const result = await fetchUpstream(fakeUrl, fetcher);
    expect(result.body).toBe("proxies: []");
    expect(result.response.status).toBe(200);
  });

  it("rejects an oversized declared response before reading it", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("small", {
      headers: { "content-length": String(UPSTREAM_MAX_BYTES + 1) },
    }));
    await expectReason(fetchUpstream(fakeUrl, fetcher), "response_too_large");
  });

  it("rejects an oversized streamed response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(UPSTREAM_MAX_BYTES + 1)));
    await expectReason(fetchUpstream(fakeUrl, fetcher), "response_too_large");
  });
});
