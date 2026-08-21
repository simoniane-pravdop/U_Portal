import { asanaRequest } from "../../../lib/asana";
import { currentUser, database, jsonError, loadState, mayEdit } from "../../../lib/server";

type SyncBody = {
  action: "read" | "create" | "update";
  nodeId: string;
  taskGid?: string;
  projectGid?: string;
  workspaceGid?: string;
  title?: string;
  description?: string;
  startOn?: string;
  dueOn?: string;
  completed?: boolean;
};

type AsanaTaskEnvelope = {
  data?: {
    gid?: string;
    workspace?: { gid?: string };
  };
  [key: string]: unknown;
};

async function addPortalFollowers(userId: string, taskGid: string, workspaceGid: string, emails: string[]) {
  if (!taskGid || !workspaceGid || !emails.length) return { added: 0, skipped: [] as string[] };
  const followerGids: string[] = [];
  const skipped: string[] = [];
  for (const email of [...new Set(emails.map((value) => value.trim().toLowerCase()).filter(Boolean))]) {
    try {
      const result = await asanaRequest(userId, `/workspaces/${encodeURIComponent(workspaceGid)}/users/${encodeURIComponent(email)}`) as { data?: { gid?: string } };
      if (result.data?.gid) followerGids.push(result.data.gid);
      else skipped.push(email);
    } catch {
      skipped.push(email);
    }
  }
  if (followerGids.length) {
    try {
      await asanaRequest(userId, `/tasks/${encodeURIComponent(taskGid)}/addFollowers`, {
        method: "POST",
        body: JSON.stringify({ data: { followers: followerGids } }),
      });
    } catch {
      return { added: 0, skipped: emails };
    }
  }
  return { added: followerGids.length, skipped };
}

export async function POST(request: Request) {
  const { state } = await loadState();
  const user = await currentUser(request, state);
  if (!user) return jsonError("Потрібен вхід", 401);
  const body = (await request.json()) as SyncBody;
  const node = state.nodes.find((candidate) => candidate.id === body.nodeId);
  if (!node) return jsonError("Об’єкт порталу не знайдено", 404);
  const mayRead = mayEdit(user, node.ownerId) || node.assigneeId === user.id || node.acceptorId === user.id || node.participantIds.includes(user.id);
  if (!mayRead || body.action !== "read" && !mayEdit(user, node.ownerId) && node.assigneeId !== user.id) return jsonError("Недостатньо повноважень", 403);

  try {
    let result: AsanaTaskEnvelope;
    if (body.action === "read") {
      if (!body.taskGid) return jsonError("Не вказано GID задачі Asana", 400);
      result = await asanaRequest(
        user.id,
        `/tasks/${encodeURIComponent(body.taskGid)}?opt_fields=name,completed,due_on,start_on,assignee.name,assignee.email,permalink_url,modified_at,notes,projects.gid,projects.name,workspace.gid,workspace.name,followers.gid,followers.name,followers.email`,
      ) as AsanaTaskEnvelope;
    } else if (body.action === "create") {
      if (!body.projectGid && !body.workspaceGid) return jsonError("Не вказано робочий простір Asana", 400);
      const db = await database();
      const connection = db ? await db.prepare("SELECT asana_user_gid FROM asana_connections WHERE user_id = ?").bind(user.id).first<{ asana_user_gid: string }>() : null;
      result = await asanaRequest(user.id, "/tasks?opt_fields=gid,name,completed,due_on,assignee.name,permalink_url,modified_at,workspace.gid,workspace.name,projects.gid,projects.name", {
        method: "POST",
        body: JSON.stringify({
          data: {
            name: body.title || node.title,
            notes: body.description || `${node.code}\n\n${node.result}\n\nКритерій приймання: ${node.acceptanceCriteria}`,
            ...(body.projectGid ? { projects: [body.projectGid] } : { workspace: body.workspaceGid }),
            start_on: body.startOn && (body.dueOn || node.plannedEnd) ? body.startOn : undefined,
            due_on: body.dueOn || node.plannedEnd || undefined,
            assignee: connection?.asana_user_gid || undefined,
          },
        }),
      }) as AsanaTaskEnvelope;
    } else {
      if (!body.taskGid) return jsonError("Не вказано GID задачі Asana", 400);
      const data: Record<string, unknown> = {};
      if (node.asana.rules.title === "portal") data.name = body.title;
      if (node.asana.rules.description === "portal") data.notes = body.description;
      if (node.asana.rules.dates === "portal") {
        data.due_on = body.dueOn || null;
        data.start_on = body.startOn && body.dueOn ? body.startOn : null;
      }
      if (node.asana.rules.status === "portal") data.completed = body.completed;
      if (!Object.keys(data).length) return jsonError("Жодне поле не визначено для передання з порталу", 400);
      result = await asanaRequest(user.id, `/tasks/${encodeURIComponent(body.taskGid)}?opt_fields=gid,name,completed,due_on,assignee.name,permalink_url,modified_at,workspace.gid,workspace.name,projects.gid,projects.name`, {
        method: "PUT",
        body: JSON.stringify({ data }),
      }) as AsanaTaskEnvelope;
    }
    const taskGid = result.data?.gid || body.taskGid || "";
    let workspaceGid = result.data?.workspace?.gid || body.workspaceGid || node.asana.workspaceGid || "";
    if (taskGid && !workspaceGid) {
      const task = await asanaRequest(user.id, `/tasks/${encodeURIComponent(taskGid)}?opt_fields=workspace.gid`) as AsanaTaskEnvelope;
      workspaceGid = task.data?.workspace?.gid || "";
    }
    const followerEmails = node.participantIds.map((id) => state.users.find((candidate) => candidate.id === id && candidate.active)?.email || "").filter(Boolean);
    const followerSync = await addPortalFollowers(user.id, taskGid, workspaceGid, followerEmails);
    const db = await database();
    if (db) {
      await db
        .prepare("INSERT INTO sync_events (id, user_id, node_id, direction, status, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), user.id, node.id, body.action === "read" ? "asana_to_portal" : "portal_to_asana", "success", body.action, new Date().toISOString())
        .run();
    }
    return Response.json({ ...result, followerSync, workspaceGid });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Помилка синхронізації", 502);
  }
}
