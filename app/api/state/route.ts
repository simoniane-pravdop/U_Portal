import { currentUser, database, jsonError, loadState, mayEdit, runtimeEnv } from "../../lib/server";
import type { PortalState } from "../../types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { state, storage } = await loadState();
  const user = await currentUser(request, state);
  if (!user) return jsonError("Потрібен вхід через корпоративний обліковий запис", 401);
  return Response.json(
    {
      ...state,
      currentUser: user,
      storage,
      authConfigured: Boolean(runtimeEnv().GOOGLE_CLIENT_ID && runtimeEnv().GOOGLE_CLIENT_SECRET),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const { state: current, storage } = await loadState();
  const user = await currentUser(request, current);
  if (!user) return jsonError("Потрібен вхід", 401);

  const body = (await request.json()) as { state?: PortalState; expectedRevision?: number; action?: string; entityId?: string };
  if (!body.state || !Array.isArray(body.state.nodes) || !Array.isArray(body.state.users)) {
    return jsonError("Некоректна структура стану", 400);
  }
  const entity = current.nodes.find((node) => node.id === body.entityId);
  const mayChangeEntity = entity
    ? mayEdit(user, entity.ownerId) || entity.assigneeId === user.id || entity.acceptorId === user.id
    : user.role === "admin";
  if (!mayChangeEntity) return jsonError("Недостатньо повноважень для цієї зміни", 403);
  if (body.expectedRevision !== current.revision) {
    return Response.json(
      { error: "Дані вже змінив інший користувач", currentRevision: current.revision },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  const next = body.state;
  next.revision = current.revision + 1;
  next.version = Math.max(1, next.version || 1);
  next.audit = [
    {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      by: user.name,
      action: body.action || "Оновлено дані порталу",
      entityId: body.entityId || "portal",
    },
    ...(Array.isArray(next.audit) ? next.audit : []),
  ].slice(0, 500);

  const db = await database();
  if (db) {
    const now = new Date().toISOString();
    const result = await db
      .prepare(
        "UPDATE portal_state SET payload = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ? AND revision = ?",
      )
      .bind(JSON.stringify(next), next.revision, now, user.email, "main", current.revision)
      .run();
    if (!result.meta.changes) return jsonError("Конфлікт одночасного редагування", 409);
  }

  return Response.json({ ...next, currentUser: user, storage, authConfigured: Boolean(runtimeEnv().GOOGLE_CLIENT_ID) });
}
