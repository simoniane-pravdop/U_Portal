import { asanaRequest } from "../../../lib/asana";
import { currentUser, database, jsonError, loadState, mayEdit } from "../../../lib/server";

type SyncBody = {
  action: "read" | "create" | "update";
  nodeId: string;
  taskGid?: string;
  projectGid?: string;
  title?: string;
  description?: string;
  dueOn?: string;
  completed?: boolean;
};

export async function POST(request: Request) {
  const { state } = await loadState();
  const user = await currentUser(request, state);
  if (!user) return jsonError("Потрібен вхід", 401);
  const body = (await request.json()) as SyncBody;
  const node = state.nodes.find((candidate) => candidate.id === body.nodeId);
  if (!node) return jsonError("Об’єкт порталу не знайдено", 404);
  if (!mayEdit(user, node.ownerId) && node.assigneeId !== user.id) return jsonError("Недостатньо повноважень", 403);

  try {
    let result: unknown;
    if (body.action === "read") {
      if (!body.taskGid) return jsonError("Не вказано GID задачі Asana", 400);
      result = await asanaRequest(
        user.id,
        `/tasks/${encodeURIComponent(body.taskGid)}?opt_fields=name,completed,due_on,start_on,assignee.name,permalink_url,modified_at,notes`,
      );
    } else if (body.action === "create") {
      if (!body.projectGid) return jsonError("Не вказано проєкт Asana", 400);
      result = await asanaRequest(user.id, "/tasks", {
        method: "POST",
        body: JSON.stringify({
          data: {
            name: body.title || node.title,
            notes: body.description || `${node.code}\n\n${node.result}\n\nКритерій приймання: ${node.acceptanceCriteria}`,
            projects: [body.projectGid],
            due_on: body.dueOn || node.plannedEnd || undefined,
          },
        }),
      });
    } else {
      if (!body.taskGid) return jsonError("Не вказано GID задачі Asana", 400);
      result = await asanaRequest(user.id, `/tasks/${encodeURIComponent(body.taskGid)}`, {
        method: "PUT",
        body: JSON.stringify({
          data: {
            name: body.title,
            notes: body.description,
            due_on: body.dueOn || null,
            completed: body.completed,
          },
        }),
      });
    }
    const db = await database();
    if (db) {
      await db
        .prepare("INSERT INTO sync_events (id, user_id, node_id, direction, status, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), user.id, node.id, body.action === "read" ? "asana_to_portal" : "portal_to_asana", "success", body.action, new Date().toISOString())
        .run();
    }
    return Response.json(result);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Помилка синхронізації", 502);
  }
}
