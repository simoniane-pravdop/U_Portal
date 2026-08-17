import { currentUser, database, jsonError, loadState } from "../../lib/server";
import type { EditingLock } from "../../types";

export const dynamic = "force-dynamic";

const LOCK_TTL_MS = 120_000;

async function activeLocks() {
  const db = await database();
  if (!db) return { db: null, locks: [] as EditingLock[] };
  const now = new Date().toISOString();
  await db.prepare("DELETE FROM portal_edit_locks WHERE expires_at <= ?").bind(now).run();
  const rows = await db.prepare("SELECT entity_id, user_id, user_name, acquired_at, expires_at FROM portal_edit_locks WHERE expires_at > ? ORDER BY acquired_at").bind(now).all<{
    entity_id: string; user_id: string; user_name: string; acquired_at: string; expires_at: string;
  }>();
  return {
    db,
    locks: (rows.results || []).map((row) => ({ entityId: row.entity_id, userId: row.user_id, userName: row.user_name, acquiredAt: row.acquired_at, expiresAt: row.expires_at })),
  };
}

export async function GET(request: Request) {
  const { state } = await loadState();
  const user = await currentUser(request, state);
  if (!user) return jsonError("Потрібен вхід", 401);
  const { locks } = await activeLocks();
  return Response.json({ locks }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const { state } = await loadState();
  const user = await currentUser(request, state);
  if (!user) return jsonError("Потрібен вхід", 401);
  const body = (await request.json().catch(() => ({}))) as { action?: "acquire" | "heartbeat" | "release"; entityId?: string };
  const entityId = body.entityId?.trim() || "";
  if (!body.action || !entityId) return jsonError("Не вказано об’єкт редагування", 400);
  const { db, locks } = await activeLocks();
  if (!db) return jsonError("Сховище блокувань недоступне", 503);

  if (body.action === "release") {
    await db.prepare("DELETE FROM portal_edit_locks WHERE entity_id = ? AND user_id = ?").bind(entityId, user.id).run();
    return Response.json({ released: true });
  }

  const existing = locks.find((lock) => lock.entityId === entityId);
  if (existing && existing.userId !== user.id) {
    return Response.json({ error: `${existing.userName} вже редагує цю картку`, lock: existing }, { status: 423, headers: { "Cache-Control": "no-store" } });
  }
  const now = new Date();
  const acquiredAt = existing?.acquiredAt || now.toISOString();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS).toISOString();
  await db.prepare(
    "INSERT INTO portal_edit_locks (entity_id, user_id, user_name, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(entity_id) DO UPDATE SET user_id=excluded.user_id, user_name=excluded.user_name, acquired_at=excluded.acquired_at, expires_at=excluded.expires_at WHERE portal_edit_locks.user_id = excluded.user_id OR portal_edit_locks.expires_at <= ?",
  ).bind(entityId, user.id, user.name, acquiredAt, expiresAt, now.toISOString()).run();
  const confirmed = await db.prepare("SELECT user_id, user_name, acquired_at, expires_at FROM portal_edit_locks WHERE entity_id = ?").bind(entityId).first<{ user_id: string; user_name: string; acquired_at: string; expires_at: string }>();
  if (!confirmed || confirmed.user_id !== user.id) return Response.json({ error: `${confirmed?.user_name || "Інший користувач"} вже редагує цю картку` }, { status: 423 });
  return Response.json({ lock: { entityId, userId: user.id, userName: user.name, acquiredAt, expiresAt } });
}
