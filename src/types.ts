export interface Env {
  UPSTREAM_SUBSCRIPTION_URL: string;
  ALLOWED_TOKENS: string;
}

export type Fetcher = typeof fetch;
