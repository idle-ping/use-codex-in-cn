import { createHash, randomBytes, scryptSync, timingSafeEqual, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";

const PASSWORD_ALGORITHM = "scrypt";
const PASSWORD_KEY_BYTES = 32;
const SESSION_TOKEN_BYTES = 32;

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function hashPassword(password: string, salt: Buffer) {
  return scryptSync(password, salt, PASSWORD_KEY_BYTES, { N: 32_768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }).toString("base64url");
}

function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

function sameSecret(left: string, right: string) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeUser(row: any) {
  if (!row) return null;
  return {
    id: String(row.id),
    username: String(row.username),
    rootDirectory: String(row.root_directory),
    status: String(row.status),
    role: String(row.role || "member"),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export class MultiUserStore {
  #db: Database;
  #rootBase: string;

  constructor({ path, rootBase }: { path: string; rootBase: string }) {
    this.#rootBase = resolve(rootBase);
    mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    mkdirSync(this.#rootBase, { recursive: true, mode: 0o700 });
    this.#db = new Database(resolve(path));
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY NOT NULL,
        username TEXT UNIQUE NOT NULL,
        password_algorithm TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        root_directory TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        role TEXT NOT NULL DEFAULT 'member',
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT UNIQUE NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        last_seen_at_ms INTEGER NOT NULL,
        revoked_at_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS sessions_token_idx ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
    `);
    try { this.#db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'"); } catch { /* Existing databases already have role. */ }
    if (!this.#db.query("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get()) {
      this.#db.exec("UPDATE users SET role = 'admin' WHERE id = (SELECT id FROM users ORDER BY created_at_ms, id LIMIT 1)");
    }
  }

  createUser({ username, password, rootDirectory, role, now = Date.now() }: { username: string; password: string; rootDirectory?: string; role?: "admin" | "member"; now?: number }) {
    const normalized = text(username).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(normalized)) throw new Error("Username must contain 2 to 64 lowercase letters, numbers, dots, underscores or hyphens");
    if (typeof password !== "string" || password.length < 12 || password.length > 256) throw new Error("Password must be between 12 and 256 characters");
    const id = randomUUID(), root = resolve(rootDirectory || `${this.#rootBase}/${id}`);
    if (root !== this.#rootBase && !root.startsWith(`${this.#rootBase}/`)) throw new Error("User root must be inside the configured user root base");
    const salt = randomBytes(16), hash = hashPassword(password, salt), timestamp = Number(now);
    try {
      const assignedRole = role || (this.userCount() === 0 ? "admin" : "member");
      this.#db.query("INSERT INTO users (id, username, password_algorithm, password_salt, password_hash, root_directory, status, role, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)").run(id, normalized, PASSWORD_ALGORITHM, salt.toString("base64url"), hash, root, assignedRole, timestamp, timestamp);
    } catch (error: any) {
      if (String(error?.message || "").includes("UNIQUE")) throw new Error("Username or user root already exists");
      throw error;
    }
    mkdirSync(root, { recursive: true, mode: 0o700 });
    return { id, username: normalized, rootDirectory: root, status: "active", role: role || (this.userCount() === 1 ? "admin" : "member"), createdAtMs: timestamp, updatedAtMs: timestamp };
  }

  getUserById(id: string) {
    return normalizeUser(this.#db.query("SELECT id, username, root_directory, status, role, created_at_ms, updated_at_ms FROM users WHERE id = ?").get(id));
  }

  userCount() {
    return Number(this.#db.query("SELECT COUNT(*) AS count FROM users").get()?.count || 0);
  }

  listUsers() {
    return this.#db.query("SELECT id, username, root_directory, status, role, created_at_ms, updated_at_ms FROM users ORDER BY username").all().map(normalizeUser);
  }

  getUserByUsername(username: string) {
    return normalizeUser(this.#db.query("SELECT id, username, root_directory, status, role, created_at_ms, updated_at_ms FROM users WHERE username = ?").get(text(username).trim().toLowerCase()));
  }

  verifyCredentials(username: string, password: string) {
    const row: any = this.#db.query("SELECT * FROM users WHERE username = ?").get(text(username).trim().toLowerCase());
    if (!row || row.status !== "active" || row.password_algorithm !== PASSWORD_ALGORITHM) return null;
    const candidate = hashPassword(password, Buffer.from(row.password_salt, "base64url"));
    return sameSecret(candidate, String(row.password_hash)) ? normalizeUser(row) : null;
  }

  createSession(userId: string, { ttlMs = 14 * 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
    if (!this.getUserById(userId)) throw new Error("User not found");
    const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url"), id = randomUUID(), tokenHash = hashSessionToken(token), expiresAt = Number(now) + Number(ttlMs);
    this.#db.query("INSERT INTO sessions (id, user_id, token_hash, expires_at_ms, created_at_ms, last_seen_at_ms) VALUES (?, ?, ?, ?, ?, ?)").run(id, userId, tokenHash, expiresAt, now, now);
    return { token, expiresAt };
  }

  getSession(token: string, { now = Date.now(), touch = true } = {}) {
    const row: any = this.#db.query("SELECT id, user_id, expires_at_ms, revoked_at_ms FROM sessions WHERE token_hash = ?").get(hashSessionToken(token));
    if (!row || row.revoked_at_ms || Number(row.expires_at_ms) <= Number(now)) return null;
    if (touch) this.#db.query("UPDATE sessions SET last_seen_at_ms = ? WHERE id = ?").run(now, row.id);
    const user = this.getUserById(row.user_id);
    return user ? { sessionId: String(row.id), user, expiresAt: Number(row.expires_at_ms) } : null;
  }

  revokeSession(token: string, now = Date.now()) {
    return this.#db.query("UPDATE sessions SET revoked_at_ms = ? WHERE token_hash = ? AND revoked_at_ms IS NULL").run(now, hashSessionToken(token)).changes > 0;
  }

  close() { this.#db.close(); }
}
