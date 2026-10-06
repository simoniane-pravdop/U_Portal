import { currentUser, database, jsonError, loadState } from "../../lib/server";
import { changeTrash, purgeTrash, TrashError } from "../../lib/trash";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { state } = await loadState();
  const user = await currentUser(request, state);
  if (!user) return jsonError("Потрібен вхід", 401);
  let body: { action?: string; nodeId?: string; expectedRevision?: number; confirmation?: string };
  try { body = await request.json(); } catch { return jsonError("Некоректний запит", 400); }
  if (!body || !["delete", "restore", "purge", "empty"].includes(body.action || "") || body.action !== "empty" && typeof body.nodeId !== "string") return jsonError("Оберіть картку та дію", 400);
  if (body.expectedRevision !== state.revision) return jsonError("Дані вже змінив інший користувач. Оновіть сторінку та повторіть дію.", 409);
  const db = await database();
  if (!db) return jsonError("Кошик потребує підключеної бази даних", 503);
  try {
    const at = new Date().toISOString();
    const permanent = body.action === "purge" || body.action === "empty";
    if (permanent && !["owner", "admin"].includes(user.role)) return jsonError("Остаточно видаляти картки може лише власник або адміністратор", 403);
    if (body.action === "empty" && body.confirmation !== "ВИДАЛИТИ ВСЕ") return jsonError("Підтвердьте очищення кошика", 400);
    if (body.action === "purge" && body.confirmation !== state.nodes.find((node) => node.id === body.nodeId)?.code) return jsonError("Підтвердьте код картки", 400);
    const { next, targets, changed } = permanent
      ? purgeTrash(state, user, body.action === "empty" ? null : body.nodeId!, at)
      : changeTrash(state, user, body.nodeId!, body.action as "delete" | "restore", at);
    for (const node of targets) {
      const lock = await db.prepare("SELECT user_id, user_name FROM portal_edit_locks WHERE entity_id = ? AND expires_at > ?").bind(node.id, at).first<{ user_id: string; user_name: string }>();
      if (lock && lock.user_id !== user.id) return jsonError(`${lock.user_name} зараз редагує ${node.code}. Дочекайтеся завершення.`, 423);
    }
    const payload = JSON.stringify(next);
    const statements = [
      db.prepare("UPDATE portal_state SET payload = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ? AND revision = ?").bind(payload, next.revision, at, user.email, "main", state.revision),
      ...targets.flatMap((node) => permanent ? [
        db.prepare("DELETE FROM portal_entity_versions WHERE entity_id = ? AND EXISTS (SELECT 1 FROM portal_state WHERE id = 'main' AND revision = ? AND payload = ?)").bind(node.id, next.revision, payload),
        db.prepare("DELETE FROM asana_outbox WHERE node_id = ? AND EXISTS (SELECT 1 FROM portal_state WHERE id = 'main' AND revision = ? AND payload = ?)").bind(node.id, next.revision, payload),
        db.prepare("DELETE FROM sync_events WHERE node_id = ? AND EXISTS (SELECT 1 FROM portal_state WHERE id = 'main' AND revision = ? AND payload = ?)").bind(node.id, next.revision, payload),
        db.prepare("DELETE FROM portal_edit_locks WHERE entity_id = ? AND EXISTS (SELECT 1 FROM portal_state WHERE id = 'main' AND revision = ? AND payload = ?)").bind(node.id, next.revision, payload),
      ] : []),
      ...changed.map((node) => db.prepare("INSERT INTO portal_entity_versions (id, entity_id, revision, user_id, user_name, action, payload, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM portal_state WHERE id = 'main' AND revision = ? AND payload = ?)")
        .bind(crypto.randomUUID(), node.id, next.revision, user.id, user.name, body.action === "delete" ? "Перенесено до кошика" : body.action === "restore" ? "Відновлено з кошика" : "Оновлено після очищення кошика", JSON.stringify(node), at, next.revision, payload)),
    ];
    const results = await db.batch(statements);
    if (!results[0].meta.changes) return jsonError("Конфлікт одночасного редагування. Оновіть сторінку.", 409);
    return Response.json({ ok: true, count: targets.length, revision: next.revision }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof TrashError) return jsonError(error.message, error.status);
    throw error;
  }
}
