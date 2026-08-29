export type StagingConfigErrorCode =
  | "STAGING_URL_NOT_CONFIGURED"
  | "STAGING_URL_INVALID"
  | "TEST_PROXY_INVALID";

export class StagingConfigError extends Error {
  constructor(readonly code: StagingConfigErrorCode) {
    super(code);
    this.name = "StagingConfigError";
  }
}

export function resolveStagingUrl(value: string | undefined): URL {
  if (!value?.trim()) throw new StagingConfigError("STAGING_URL_NOT_CONFIGURED");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        url.pathname !== "/" || url.search || url.hash ||
        !url.hostname.startsWith("zackcloud-lite-staging.") || !url.hostname.endsWith(".workers.dev")) {
      throw new StagingConfigError("STAGING_URL_INVALID");
    }
    return url;
  } catch (error) {
    if (error instanceof StagingConfigError) throw error;
    throw new StagingConfigError("STAGING_URL_INVALID");
  }
}

export function resolveTestProxy(environment: Record<string, string | undefined>): string | undefined {
  const value = environment.ZACKCLOUD_TEST_PROXY ?? environment.HTTPS_PROXY ?? environment.HTTP_PROXY;
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw new StagingConfigError("TEST_PROXY_INVALID");
    }
    return url.href;
  } catch (error) {
    if (error instanceof StagingConfigError) throw error;
    throw new StagingConfigError("TEST_PROXY_INVALID");
  }
}
