import type { Fetcher } from "./types";

const UPSTREAM_TIMEOUT_MS = 10_000;
export const UPSTREAM_USER_AGENT = "clash.meta";

export type UpstreamFailureReason =
  | "missing_config"
  | "timeout"
  | "network_error"
  | "http_403"
  | "http_404"
  | "http_429"
  | "http_5xx"
  | "empty_response";

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
    const body = await response.text();
    if (body.trim() === "") throw new UpstreamError("empty_response");
    return { response, body };
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError(controller.signal.aborted ? "timeout" : "network_error");
  } finally {
    clearTimeout(timeout);
  }
}
