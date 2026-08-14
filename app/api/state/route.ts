import { currentUser, database, jsonError, loadState, mayEdit, runtimeEnv } from "../../lib/server";
import type { PortalState } from "../../types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { state, storage } = await loadState();
  const user = await currentUser(request, state);
  if (!user) return jsonError("Потрібен вхід за корпоративною адресою", 401);
  return Response.json(
    {
      ...state,
      currentUser: user,
      storage,
      authConfigured: Boolean(runtimeEnv().PORTAL_OWNER_CREDENTIAL || runtimeEnv().GOOGLE_CLIENT_ID),
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
  if (JSON.stringify(body.state.users) !== JSON.stringify(current.users)) {
    return jsonError("Користувачі та права змінюються лише в налаштуваннях порталу", 403);
  }
  if (JSON.stringify(body.state.audit) !== JSON.stringify(current.audit)) {
    return jsonError("Журнал змін формується сервером і не може редагуватися вручну", 403);
  }
  if (JSON.stringify(body.state.settings) !== JSON.stringify(current.settings) && !["owner", "admin"].includes(user.role)) {
    return jsonError("Налаштування порталу може змінювати лише власник або адміністратор", 403);
  }

  const nodeIds = new Set([...current.nodes.map((node) => node.id), ...body.state.nodes.map((node) => node.id)]);
  const changedNodeIds = [...nodeIds].filter((id) => {
    const before = current.nodes.find((node) => node.id === id);
    const after = body.state!.nodes.find((node) => node.id === id);
    return JSON.stringify(before) !== JSON.stringify(after);
  });
  for (const id of changedNodeIds) {
    const before = current.nodes.find((node) => node.id === id);
    const after = body.state.nodes.find((node) => node.id === id);
    if (!after) return jsonError("Записи не видаляються фізично — використайте контрольоване вилучення з дерева", 400);
    const mayCreate = !before && ["owner", "admin", "goal_owner", "cycle_owner", "coordinator"].includes(user.role);
    const mayChange = before && (mayEdit(user, before.ownerId) || before.assigneeId === user.id || before.acceptorId === user.id);
    if (!mayCreate && !mayChange) return jsonError("Недостатньо повноважень для однієї зі змін", 403);
  }

  const affectedNodeIds = new Set<string>();
  const collectChanged = <T extends { id: string }>(before: T[], after: T[], nodeIdsFor: (item: T) => string[]) => {
    const ids = new Set([...before.map((item) => item.id), ...after.map((item) => item.id)]);
    for (const id of ids) {
      const oldItem = before.find((item) => item.id === id);
      const newItem = after.find((item) => item.id === id);
      if (JSON.stringify(oldItem) !== JSON.stringify(newItem)) {
        for (const nodeId of nodeIdsFor(newItem || oldItem!)) affectedNodeIds.add(nodeId);
      }
    }
  };
  collectChanged(current.dependencies, body.state.dependencies, (item) => [item.predecessorId, item.successorId]);
  collectChanged(current.blockers, body.state.blockers, (item) => [item.nodeId]);
  collectChanged(current.decisions, body.state.decisions, (item) => [item.nodeId]);
  collectChanged(current.acceptances, body.state.acceptances, (item) => [item.nodeId]);
  collectChanged(current.coordinations, body.state.coordinations, (item) => [item.subcycleId]);
  for (const id of affectedNodeIds) {
    const node = current.nodes.find((candidate) => candidate.id === id) || body.state.nodes.find((candidate) => candidate.id === id);
    if (!node || !(mayEdit(user, node.ownerId) || node.assigneeId === user.id || node.acceptorId === user.id)) {
      return jsonError("Недостатньо повноважень для пов’язаної зміни", 403);
    }
  }
  if (body.expectedRevision !== current.revision) {
    return Response.json(
      { error: "Дані вже змінив інший користувач", currentRevision: current.revision },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  const next = body.state;
  next.revision = current.revision + 1;
  next.version = Math.max(2, next.version || 2);
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

  return Response.json({ ...next, currentUser: user, storage, authConfigured: Boolean(runtimeEnv().PORTAL_OWNER_CREDENTIAL || runtimeEnv().GOOGLE_CLIENT_ID) });
}
