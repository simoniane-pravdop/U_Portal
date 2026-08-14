import { env } from "cloudflare:workers";
import seed from "../data/seed.json";
import type { PortalState, PortalUser, SessionUser } from "../types";

type RuntimeEnv = {
  DB?: D1Database;
  FILES?: R2Bucket;
  PORTAL_OWNER_CREDENTIAL?: string;
  PORTAL_ADMIN_CREDENTIAL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_ALLOWED_DOMAIN?: string;
  PORTAL_BASE_URL?: string;
  ASANA_CLIENT_ID?: string;
  ASANA_CLIENT_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
};

export function runtimeEnv() {
  return env as unknown as RuntimeEnv;
}

export function isLocal(request: Request) {
  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1";
}

export function parseCookies(request: Request) {
  const source = request.headers.get("cookie") || "";
  return Object.fromEntries(
    source
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=");
        const key = index >= 0 ? item.slice(0, index) : item;
        const value = index >= 0 ? item.slice(index + 1) : "";
        return [decodeURIComponent(key), decodeURIComponent(value)];
      }),
  );
}

export function cookieHeader(
  name: string,
  value: string,
  request: Request,
  options: { maxAge?: number; httpOnly?: boolean } = {},
) {
  const secure = !isLocal(request);
  return [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    "Path=/",
    `SameSite=Lax`,
    options.httpOnly === false ? "" : "HttpOnly",
    secure ? "Secure" : "",
    typeof options.maxAge === "number" ? `Max-Age=${options.maxAge}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS portal_state (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS portal_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    auth_mode TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_portal_sessions_expires_at
    ON portal_sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS portal_credentials (
    user_id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_iterations INTEGER NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS portal_login_attempts (
    identifier TEXT PRIMARY KEY,
    failed_count INTEGER NOT NULL DEFAULT 0,
    first_failed_at TEXT NOT NULL,
    locked_until TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS asana_connections (
    user_id TEXT PRIMARY KEY,
    asana_user_gid TEXT NOT NULL,
    asana_user_name TEXT NOT NULL,
    encrypted_access_token TEXT NOT NULL,
    encrypted_refresh_token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    scope TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sync_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sync_events_user_created
    ON sync_events(user_id, created_at)`,
];

export async function database() {
  const db = runtimeEnv().DB;
  if (!db) return null;
  await db.batch(schemaStatements.map((sql) => db.prepare(sql)));
  return db;
}

export function seedState(): PortalState {
  return structuredClone(seed) as PortalState;
}

function cleanInitialState(state: PortalState, revision: number): PortalState {
  const clean = seedState();
  clean.version = 2;
  clean.revision = revision;
  clean.audit = [
    {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      by: "Система",
      action: "Очищено тестові дані та створено початкових адміністраторів",
      entityId: "portal",
    },
  ];
  clean.settings = { ...state.settings, ...clean.settings };
  return clean;
}

export async function loadState(): Promise<{ state: PortalState; storage: "database" | "memory" }> {
  const db = await database();
  if (!db) return { state: seedState(), storage: "memory" };
  const row = await db
    .prepare("SELECT payload, revision FROM portal_state WHERE id = ?")
    .bind("main")
    .first<{ payload: string; revision: number }>();
  if (row?.payload) {
    let state = JSON.parse(row.payload) as PortalState;
    if ((state.version || 1) < 2) {
      state = cleanInitialState(state, row.revision + 1);
      const now = new Date().toISOString();
      await db.batch([
        db.prepare("UPDATE portal_state SET payload = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ?")
          .bind(JSON.stringify(state), state.revision, now, "Система", "main"),
        db.prepare("DELETE FROM portal_sessions"),
        db.prepare("DELETE FROM portal_credentials WHERE user_id NOT IN (?, ?)").bind("u-gurlov", "u-edhar"),
      ]);
    } else {
      state.revision = row.revision;
    }
    return { state, storage: "database" };
  }
  const state = seedState();
  const now = new Date().toISOString();
  await db
    .prepare("INSERT INTO portal_state (id, payload, revision, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)")
    .bind("main", JSON.stringify(state), state.revision, now, "Система")
    .run();
  return { state, storage: "database" };
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const PASSWORD_ITERATIONS = 210_000;

function bytesToBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export type PasswordCredential = {
  passwordHash: string;
  passwordSalt: string;
  passwordIterations: number;
};

export async function hashPassword(password: string, iterations = PASSWORD_ITERATIONS): Promise<PasswordCredential> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return {
    passwordHash: bytesToBase64(new Uint8Array(bits)),
    passwordSalt: bytesToBase64(salt),
    passwordIterations: iterations,
  };
}

export async function verifyPassword(password: string, credential: PasswordCredential) {
  if (!credential.passwordHash || !credential.passwordSalt || credential.passwordIterations < 100_000) return false;
  try {
    const salt = base64ToBytes(credential.passwordSalt);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: credential.passwordIterations },
      key,
      256,
    ));
    const expected = base64ToBytes(credential.passwordHash);
    if (bits.length !== expected.length) return false;
    let mismatch = 0;
    for (let index = 0; index < bits.length; index += 1) mismatch |= bits[index] ^ expected[index];
    return mismatch === 0;
  } catch {
    return false;
  }
}

export function parsePasswordCredential(value?: string): PasswordCredential | null {
  const [scheme, iterations, salt, hash, ...rest] = (value || "").split(":");
  const count = Number(iterations);
  if (scheme !== "pbkdf2" || rest.length || !salt || !hash || !Number.isInteger(count)) return null;
  return { passwordHash: hash, passwordSalt: salt, passwordIterations: count };
}

export function bootstrapCredential(user: PortalUser) {
  const value = user.role === "owner" ? runtimeEnv().PORTAL_OWNER_CREDENTIAL : user.role === "admin" ? runtimeEnv().PORTAL_ADMIN_CREDENTIAL : undefined;
  return parsePasswordCredential(value);
}

export function validatePassword(password: string) {
  if (password.length < 12) return "Пароль має містити щонайменше 12 символів";
  if (!/[a-zа-яіїєґ]/u.test(password) || !/[A-ZА-ЯІЇЄҐ]/u.test(password) || !/\d/.test(password) || !/[^\p{L}\p{N}]/u.test(password)) {
    return "Пароль має містити великі й малі літери, цифру та спеціальний символ";
  }
  return "";
}

export function randomToken(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function createSession(request: Request, user: PortalUser, authMode: SessionUser["authMode"]) {
  const db = await database();
  if (!db) return null;
  const token = randomToken();
  const tokenHash = await sha256(token);
  const now = new Date();
  const expires = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 14);
  await db
    .prepare(
      "INSERT INTO portal_sessions (token_hash, user_id, email, name, auth_mode, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(tokenHash, user.id, user.email, user.name, authMode, expires.toISOString(), now.toISOString())
    .run();
  return cookieHeader("mgmt_session", token, request, { maxAge: 60 * 60 * 24 * 14 });
}

export async function currentUser(request: Request, state?: PortalState): Promise<SessionUser | null> {
  const loaded = state || (await loadState()).state;
  const cookies = parseCookies(request);
  const platformEmail = request.headers.get("oai-authenticated-user-email");
  if (platformEmail) {
    const user = loaded.users.find((candidate) => candidate.email.toLowerCase() === platformEmail.toLowerCase());
    if (user?.active) return { ...user, authMode: "platform" };
  }

  const token = cookies.mgmt_session;
  if (!token) return null;
  const db = await database();
  if (!db) return null;
  const tokenHash = await sha256(token);
  const row = await db
    .prepare("SELECT user_id, email, name, auth_mode, expires_at FROM portal_sessions WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ user_id: string; email: string; name: string; auth_mode: SessionUser["authMode"]; expires_at: string }>();
  if (!row || row.expires_at <= new Date().toISOString()) return null;
  const user = loaded.users.find((candidate) => candidate.id === row.user_id && candidate.active);
  return user ? { ...user, authMode: row.auth_mode } : null;
}

export function mayEdit(user: SessionUser, nodeOwnerId?: string) {
  return ["owner", "admin", "goal_owner", "cycle_owner", "coordinator"].includes(user.role) || user.id === nodeOwnerId;
}

export function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export function baseUrl(request: Request) {
  return runtimeEnv().PORTAL_BASE_URL || new URL(request.url).origin;
}
