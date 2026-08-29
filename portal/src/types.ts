export type UserStatus = "PENDING" | "APPROVED" | "REJECTED" | "DISABLED";
export type SessionRole = "USER" | "ADMIN";

export interface PortalEnv {
  AUTH_DB: D1Database;
  USER_LOGIN_RATE_LIMITER: RateLimit;
  ADMIN_LOGIN_RATE_LIMITER: RateLimit;
  TOKEN_ENCRYPTION_KEY?: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD_HASH?: string;
  REGISTRATION_INVITE_CODE_HASH?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  PORTAL_ORIGIN?: string;
  SESSION_TTL_SECONDS?: string;
  ZACKCLOUD_PUBLIC_BASE_URL?: string;
}

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  passwordSalt: string;
  passwordIterations: number;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  expiresAt: string | null;
}

export interface CredentialRecord {
  userId: string;
  tokenHash: string;
  tokenCiphertext: string;
  tokenIv: string;
  createdAt: string;
  rotatedAt: string | null;
}

export interface SessionRecord {
  sessionHash: string;
  principalId: string;
  role: SessionRole;
  csrfHash: string;
  createdAt: string;
  expiresAt: string;
}

export interface AuditRecord {
  actor: string;
  action: string;
  targetUserId: string | null;
  createdAt: string;
  detail: string | null;
}

export interface StatusCounts {
  pending: number;
  approved: number;
  disabled: number;
  total: number;
}
