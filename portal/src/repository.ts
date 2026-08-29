import type {
  AuditRecord,
  CredentialRecord,
  SessionRecord,
  SessionRole,
  StatusCounts,
  UserRecord,
  UserStatus,
} from "./types";

export interface NewUser {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  passwordSalt: string;
  passwordIterations: number;
  now: string;
}

export interface PortalRepository {
  createUser(user: NewUser): Promise<void>;
  findUserByUsername(username: string): Promise<UserRecord | null>;
  getUser(id: string): Promise<UserRecord | null>;
  listUsers(): Promise<UserRecord[]>;
  statusCounts(): Promise<StatusCounts>;
  createSession(session: SessionRecord): Promise<void>;
  getSession(hash: string): Promise<SessionRecord | null>;
  deleteSession(hash: string): Promise<void>;
  getCredential(userId: string): Promise<CredentialRecord | null>;
  approveUser(userId: string, credential: CredentialRecord, actor: string, now: string): Promise<void>;
  setUserStatus(userId: string, status: UserStatus, actor: string, action: AuditRecord["action"], now: string): Promise<void>;
  setUserExpiry(userId: string, expiresAt: string | null, actor: string, now: string): Promise<void>;
  rotateCredential(userId: string, credential: CredentialRecord, actor: string, now: string): Promise<void>;
  deleteUser(userId: string, actor: string, now: string): Promise<void>;
  listAuditLogs(): Promise<AuditRecord[]>;
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
  status: UserStatus;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  expires_at: string | null;
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    passwordIterations: row.password_iterations,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at,
    expiresAt: row.expires_at,
  };
}

export class D1PortalRepository implements PortalRepository {
  constructor(private readonly db: D1Database) {}

  async createUser(user: NewUser): Promise<void> {
    await this.db.prepare(`INSERT INTO users
      (id, username, display_name, password_hash, password_salt, password_iterations, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`)
      .bind(user.id, user.username, user.displayName, user.passwordHash, user.passwordSalt,
        user.passwordIterations, user.now, user.now).run();
  }

  async findUserByUsername(username: string): Promise<UserRecord | null> {
    const row = await this.db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE LIMIT 1")
      .bind(username).first<UserRow>();
    return row ? mapUser(row) : null;
  }

  async getUser(id: string): Promise<UserRecord | null> {
    const row = await this.db.prepare("SELECT * FROM users WHERE id = ? LIMIT 1").bind(id).first<UserRow>();
    return row ? mapUser(row) : null;
  }

  async listUsers(): Promise<UserRecord[]> {
    const result = await this.db.prepare("SELECT * FROM users ORDER BY created_at DESC").all<UserRow>();
    return result.results.map(mapUser);
  }

  async statusCounts(): Promise<StatusCounts> {
    const row = await this.db.prepare(`SELECT
      SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'APPROVED' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status = 'DISABLED' THEN 1 ELSE 0 END) AS disabled,
      COUNT(*) AS total FROM users`).first<Record<string, number>>();
    return {
      pending: Number(row?.pending ?? 0),
      approved: Number(row?.approved ?? 0),
      disabled: Number(row?.disabled ?? 0),
      total: Number(row?.total ?? 0),
    };
  }

  async createSession(session: SessionRecord): Promise<void> {
    await this.db.prepare(`INSERT INTO sessions
      (session_hash, principal_id, role, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(session.sessionHash, session.principalId, session.role, session.csrfHash,
        session.createdAt, session.expiresAt).run();
  }

  async getSession(hash: string): Promise<SessionRecord | null> {
    const row = await this.db.prepare("SELECT * FROM sessions WHERE session_hash = ? LIMIT 1")
      .bind(hash).first<Record<string, unknown>>();
    if (!row) return null;
    return {
      sessionHash: String(row.session_hash),
      principalId: String(row.principal_id),
      role: String(row.role) as SessionRole,
      csrfHash: String(row.csrf_hash),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
    };
  }

  async deleteSession(hash: string): Promise<void> {
    await this.db.prepare("DELETE FROM sessions WHERE session_hash = ?").bind(hash).run();
  }

  async getCredential(userId: string): Promise<CredentialRecord | null> {
    const row = await this.db.prepare("SELECT * FROM subscription_credentials WHERE user_id = ? LIMIT 1")
      .bind(userId).first<Record<string, unknown>>();
    if (!row) return null;
    return {
      userId: String(row.user_id),
      tokenHash: String(row.token_hash),
      tokenCiphertext: String(row.token_ciphertext),
      tokenIv: String(row.token_iv),
      createdAt: String(row.created_at),
      rotatedAt: row.rotated_at === null ? null : String(row.rotated_at),
    };
  }

  async approveUser(userId: string, credential: CredentialRecord, actor: string, now: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("UPDATE users SET status = 'APPROVED', approved_at = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'")
        .bind(now, now, userId),
      this.db.prepare(`INSERT INTO subscription_credentials
        (user_id, token_hash, token_ciphertext, token_iv, created_at, rotated_at) VALUES (?, ?, ?, ?, ?, NULL)`)
        .bind(userId, credential.tokenHash, credential.tokenCiphertext, credential.tokenIv, credential.createdAt),
      this.audit(actor, "approve", userId, now, null),
    ]);
  }

  async setUserStatus(
    userId: string, status: UserStatus, actor: string, action: AuditRecord["action"], now: string,
  ): Promise<void> {
    await this.db.batch([
      this.db.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?").bind(status, now, userId),
      this.audit(actor, action, userId, now, null),
    ]);
  }

  async setUserExpiry(userId: string, expiresAt: string | null, actor: string, now: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("UPDATE users SET expires_at = ?, updated_at = ? WHERE id = ?").bind(expiresAt, now, userId),
      this.audit(actor, "expire", userId, now, expiresAt ? "scheduled" : "never"),
    ]);
  }

  async rotateCredential(userId: string, credential: CredentialRecord, actor: string, now: string): Promise<void> {
    await this.db.batch([
      this.db.prepare(`UPDATE subscription_credentials SET token_hash = ?, token_ciphertext = ?, token_iv = ?,
        rotated_at = ? WHERE user_id = ?`)
        .bind(credential.tokenHash, credential.tokenCiphertext, credential.tokenIv, now, userId),
      this.audit(actor, "rotate", userId, now, null),
    ]);
  }

  async deleteUser(userId: string, actor: string, now: string): Promise<void> {
    await this.db.batch([
      this.audit(actor, "delete", userId, now, null),
      this.db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
    ]);
  }

  async listAuditLogs(): Promise<AuditRecord[]> {
    const result = await this.db.prepare("SELECT actor, action, target_user_id, created_at, detail FROM audit_logs ORDER BY id DESC LIMIT 100")
      .all<Record<string, unknown>>();
    return result.results.map((row) => ({
      actor: String(row.actor),
      action: String(row.action),
      targetUserId: row.target_user_id === null ? null : String(row.target_user_id),
      createdAt: String(row.created_at),
      detail: row.detail === null ? null : String(row.detail),
    }));
  }

  private audit(actor: string, action: string, target: string, now: string, detail: string | null): D1PreparedStatement {
    return this.db.prepare(`INSERT INTO audit_logs (actor, action, target_user_id, created_at, detail)
      VALUES (?, ?, ?, ?, ?)`).bind(actor, action, target, now, detail);
  }
}
