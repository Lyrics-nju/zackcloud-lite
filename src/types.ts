export interface Env {
  ALLOWED_TOKENS?: string;
  FRIENDS_CONFIG_JSON?: string;
  AUTH_DB?: D1Database;
  SUBSCRIPTION_STORE?: KVNamespace;
}

export type Fetcher = typeof fetch;
