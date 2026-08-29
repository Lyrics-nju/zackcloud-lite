export const DEFAULT_PUBLIC_BASE_URL = "https://sub.zackcloud.site";

export function resolvePublicBaseUrl(value: string | undefined): URL {
  const configured = value?.trim() || DEFAULT_PUBLIC_BASE_URL;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) {
      throw new Error();
    }
    url.pathname = `${url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "")}/`;
    return url;
  } catch {
    throw new Error("PUBLIC_BASE_URL_INVALID");
  }
}

export function friendSubscriptionUrl(
  token: string,
  environment: Record<string, string | undefined>,
): string {
  return new URL(`sub/${encodeURIComponent(token)}`, resolvePublicBaseUrl(environment.ZACKCLOUD_PUBLIC_BASE_URL)).href;
}
