import { env } from "cloudflare:workers";
import seed from "../data/seed.json";
import type { PortalState, PortalUser, SessionUser } from "../types";

type RuntimeEnv = {
  DB?: D1Database;
  FILES?: R2Bucket;
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

export async function loadState(): Promise<{ state: PortalState; storage: "database" | "memory" }> {
  const db = await database();
  if (!db) return { state: seedState(), storage: "memory" };
  const row = await db
    .prepare("SELECT payload, revision FROM portal_state WHERE id = ?")
    .bind("main")
    .first<{ payload: string; revision: number }>();
  if (row?.payload) {
    const state = JSON.parse(row.payload) as PortalState;
    state.revision = row.revision;
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
  if (isLocal(request)) {
    const id = cookies.portal_local_user || "u-edhar";
    const user = loaded.users.find((candidate) => candidate.id === id && candidate.active) || loaded.users[0];
    return user ? { ...user, authMode: "local" } : null;
  }

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
  return ["admin", "goal_owner", "cycle_owner", "coordinator"].includes(user.role) || user.id === nodeOwnerId;
}

export function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export function baseUrl(request: Request) {
  return runtimeEnv().PORTAL_BASE_URL || new URL(request.url).origin;
}
