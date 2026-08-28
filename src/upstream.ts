import type { Fetcher } from "./types";

const UPSTREAM_TIMEOUT_MS = 10_000;
export const UPSTREAM_MAX_BYTES = 5 * 1024 * 1024;
export const UPSTREAM_USER_AGENT = "clash.meta";

export type UpstreamFailureReason =
  | "missing_config"
  | "timeout"
  | "network_error"
  | "http_403"
  | "http_404"
  | "http_429"
  | "http_5xx"
  | "empty_response"
  | "response_too_large";

export class UpstreamError extends Error {
  constructor(readonly reason: UpstreamFailureReason) {
    super("upstream request failed");
    this.name = "UpstreamError";
  }
}

export interface UpstreamResult {
  response: Response;
  body: string;
}

async function readLimitedBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > UPSTREAM_MAX_BYTES) {
    throw new UpstreamError("response_too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > UPSTREAM_MAX_BYTES) {
      await reader.cancel();
      throw new UpstreamError("response_too_large");
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

function reasonForStatus(status: number): UpstreamFailureReason {
  if (status === 403) return "http_403";
  if (status === 404) return "http_404";
  if (status === 429) return "http_429";
  if (status >= 500) return "http_5xx";
  return "network_error";
}

export async function fetchUpstream(url: string, fetcher: Fetcher): Promise<UpstreamResult> {
  if (!url) throw new UpstreamError("missing_config");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      headers: {
        Accept: "application/yaml, text/yaml, application/json, text/plain",
        "User-Agent": UPSTREAM_USER_AGENT,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new UpstreamError(reasonForStatus(response.status));
    const body = await readLimitedBody(response);
    if (body.trim() === "") throw new UpstreamError("empty_response");
    return { response, body };
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError(controller.signal.aborted ? "timeout" : "network_error");
  } finally {
    clearTimeout(timeout);
  }
}
