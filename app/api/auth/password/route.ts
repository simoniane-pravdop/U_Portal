import {
  bootstrapCredential,
  createSession,
  database,
  jsonError,
  loadState,
  verifyPassword,
} from "../../../lib/server";

export const dynamic = "force-dynamic";

type StoredCredential = {
  password_hash: string;
  password_salt: string;
  password_iterations: number;
};

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

async function recordFailure(db: D1Database, identifier: string) {
  const now = new Date();
  const row = await db.prepare("SELECT failed_count, first_failed_at FROM portal_login_attempts WHERE identifier = ?")
    .bind(identifier)
    .first<{ failed_count: number; first_failed_at: string }>();
  const windowExpired = !row || new Date(row.first_failed_at).getTime() + WINDOW_MS <= now.getTime();
  const failedCount = windowExpired ? 1 : row.failed_count + 1;
  const firstFailedAt = windowExpired ? now.toISOString() : row.first_failed_at;
  const lockedUntil = failedCount >= MAX_FAILURES ? new Date(now.getTime() + WINDOW_MS).toISOString() : "";
  await db.prepare(
    "INSERT INTO portal_login_attempts (identifier, failed_count, first_failed_at, locked_until) VALUES (?, ?, ?, ?) ON CONFLICT(identifier) DO UPDATE SET failed_count = excluded.failed_count, first_failed_at = excluded.first_failed_at, locked_until = excluded.locked_until",
  ).bind(identifier, failedCount, firstFailedAt, lockedUntil).run();
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string };
  const email = body.email?.trim().toLowerCase() || "";
  const password = body.password || "";
  if (!email || !password) return jsonError("Введіть корпоративну адресу та пароль", 400);

  const db = await database();
  if (!db) return jsonError("Сховище облікових записів недоступне", 503);
  const attempt = await db.prepare("SELECT locked_until FROM portal_login_attempts WHERE identifier = ?")
    .bind(email)
    .first<{ locked_until: string }>();
  if (attempt?.locked_until && attempt.locked_until > new Date().toISOString()) {
    return jsonError("Забагато невдалих спроб. Спробуйте ще раз через 15 хвилин", 429);
  }

  const { state } = await loadState();
  const user = state.users.find((candidate) => candidate.active && candidate.email.toLowerCase() === email);
  const stored = user
    ? await db.prepare("SELECT password_hash, password_salt, password_iterations FROM portal_credentials WHERE user_id = ?")
      .bind(user.id)
      .first<StoredCredential>()
    : null;
  const credential = stored
    ? { passwordHash: stored.password_hash, passwordSalt: stored.password_salt, passwordIterations: stored.password_iterations }
    : user ? bootstrapCredential(user) : null;
  const valid = Boolean(user && credential && await verifyPassword(password, credential));
  if (!valid || !user || !credential) {
    await recordFailure(db, email);
    return jsonError("Неправильна адреса або пароль", 401);
  }

  const now = new Date().toISOString();
  if (!stored) {
    await db.prepare(
      "INSERT INTO portal_credentials (user_id, email, password_hash, password_salt, password_iterations, must_change_password, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?) ON CONFLICT(user_id) DO NOTHING",
    ).bind(user.id, user.email.toLowerCase(), credential.passwordHash, credential.passwordSalt, credential.passwordIterations, now, now, "bootstrap").run();
  }
  await db.prepare("DELETE FROM portal_login_attempts WHERE identifier = ?").bind(email).run();
  const cookie = await createSession(request, user, "password");
  if (!cookie) return jsonError("Не вдалося створити захищену сесію", 503);
  return Response.json(
    { ok: true, user: { id: user.id, name: user.name, role: user.role } },
    { headers: { "Set-Cookie": cookie, "Cache-Control": "no-store" } },
  );
}
