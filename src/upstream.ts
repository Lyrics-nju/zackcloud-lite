import type { Fetcher } from "./types";

const UPSTREAM_TIMEOUT_MS = 10_000;
export const UPSTREAM_USER_AGENT = "clash.meta";

export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

export async function fetchUpstream(url: string, fetcher: Fetcher): Promise<Response> {
  if (!url) throw new UpstreamError("未配置上游订阅");

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
    if (!response.ok) throw new UpstreamError(`上游响应异常（HTTP ${response.status}）`);
    return response;
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError("无法获取上游订阅");
  } finally {
    clearTimeout(timeout);
  }
}
