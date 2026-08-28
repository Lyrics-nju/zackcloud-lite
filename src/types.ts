export interface Env {
  ALLOWED_TOKENS?: string;
  FRIENDS_CONFIG_JSON?: string;
  SUBSCRIPTION_STORE?: KVNamespace;
}

export type Fetcher = typeof fetch;
