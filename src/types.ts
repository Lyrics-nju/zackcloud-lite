export interface Env {
  UPSTREAM_SUBSCRIPTION_URL: string;
  ALLOWED_TOKENS: string;
  FRIENDS_CONFIG_JSON?: string;
}

export type Fetcher = typeof fetch;
