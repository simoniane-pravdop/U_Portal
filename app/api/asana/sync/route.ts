import { asanaRequest } from "../../../lib/asana";
import { ASANA_MANAGEMENT_TAG, portalOriginId, primaryAsanaTitle } from "../../../lib/asana-integration";
import { currentUser, database, jsonError, loadState, mayEdit } from "../../../lib/server";
import type { PortalState, WorkUpdate } from "../../../types";

type SyncBody = {
  action: "read" | "create" | "update" | "rename";
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

type AsanaStory = { gid: string; resource_subtype?: string; text?: string; created_at?: string; created_by?: { gid?: string; name?: string; email?: string } };

async function readComments(userId: string, taskGid: string) {
  const stories: AsanaStory[] = [];
  let offset = "";
  for (let page = 0; page < 10; page += 1) {
    const params = new URLSearchParams({ limit: "100", opt_fields: "gid,resource_subtype,text,created_at,created_by.gid,created_by.name,created_by.email" });
    if (offset) params.set("offset", offset);
    const result = await asanaRequest(userId, `/tasks/${encodeURIComponent(taskGid)}/stories?${params}`) as { data?: AsanaStory[]; next_page?: { offset?: string } | null };
    stories.push(...(result.data || []).filter((story) => story.resource_subtype === "comment_added"));
    offset = result.next_page?.offset || "";
    if (!offset) return { stories, partial: false };
  }
  return { stories, partial: Boolean(offset) };
}

function mergeAsanaComments(state: PortalState, nodeId: string, stories: AsanaStory[]) {
  const node = state.nodes.find((item) => item.id === nodeId);
  if (!node) return 0;
  let added = 0;
  for (const story of stories) {
    const content = story.text?.trim() || "";
    if (!content || !story.gid || portalOriginId(content)) continue;
    const author = state.users.find((candidate) => candidate.email.toLowerCase() === story.created_by?.email?.toLowerCase());
    if (/^(\[Звіт\]|#звіт\b|Звіт\s*[:·])/i.test(content)) {
      if ((node.updates || []).some((report) => report.asanaStoryGid === story.gid)) continue;
      const report: WorkUpdate = { id: `asana-story:${story.gid}`, asanaStoryGid: story.gid, lifecycle: node.lifecycle, health: node.health, progress: node.progress, forecastEnd: node.forecastEnd, summary: content, nextAction: "", createdAt: story.created_at || new Date().toISOString(), createdBy: author?.id || "", externalAuthorName: story.created_by?.name || "Asana", source: "asana" };
      node.updates = [report, ...(node.updates || [])];
    } else {
      if (state.discussions.some((message) => message.asanaStoryGid === story.gid)) continue;
      state.discussions.push({ id: `asana-story:${story.gid}`, asanaStoryGid: story.gid, nodeId, authorId: author?.id || "", externalAuthorName: story.created_by?.name || "Asana", text: content, kind: "comment", createdAt: story.created_at || new Date().toISOString() });
    }
    added += 1;
  }
  return added;
}

async function persistAsanaComments(nodeId: string, stories: AsanaStory[]) {
  const db = await database();
  if (!db || !stories.length) return 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { state } = await loadState();
    const added = mergeAsanaComments(state, nodeId, stories);
    if (!added) return 0;
    const oldRevision = state.revision;
    state.revision += 1;
    const now = new Date().toISOString();
    state.audit.unshift({ id: crypto.randomUUID(), at: now, by: "Asana", action: `Імпортовано коментарі та звіти Asana: ${added}`, entityId: nodeId });
    state.audit = state.audit.slice(0, 2000);
    const saved = await db.prepare("UPDATE portal_state SET payload = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ? AND revision = ?")
      .bind(JSON.stringify(state), state.revision, now, "Asana", "main", oldRevision).run();
    if (saved.meta.changes === 1) return added;
  }
  throw new Error("Під час імпорту коментарів картку змінено. Повторіть оновлення з Asana.");
}

async function ensureManagementTag(userId: string, taskGid: string, workspaceGid: string) {
  if (!workspaceGid) return "Робочий простір не визначено — позначку не додано";
  try {
    const task = await asanaRequest(userId, `/tasks/${encodeURIComponent(taskGid)}?opt_fields=tags.gid,tags.name`) as { data?: { tags?: Array<{ gid: string; name: string }> } };
    if (task.data?.tags?.some((tag) => tag.name === ASANA_MANAGEMENT_TAG)) return "";
    let offset = "";
    let tagGid = "";
    for (let page = 0; page < 10; page += 1) {
      const params = new URLSearchParams({ limit: "100", opt_fields: "gid,name" });
      if (offset) params.set("offset", offset);
      const tags = await asanaRequest(userId, `/workspaces/${encodeURIComponent(workspaceGid)}/tags?${params}`) as { data?: Array<{ gid: string; name: string }>; next_page?: { offset?: string } | null };
      tagGid = tags.data?.find((tag) => tag.name === ASANA_MANAGEMENT_TAG)?.gid || "";
      offset = tags.next_page?.offset || "";
      if (tagGid || !offset) break;
    }
    if (!tagGid && offset) return "Позначку не знайдено серед перших 1000 позначок робочого простору";
    if (!tagGid) {
      const created = await asanaRequest(userId, `/workspaces/${encodeURIComponent(workspaceGid)}/tags`, { method: "POST", body: JSON.stringify({ data: { name: ASANA_MANAGEMENT_TAG } }) }) as { data?: { gid?: string } };
      tagGid = created.data?.gid || "";
    }
    if (!tagGid) return "Не вдалося створити позначку Asana";
    await asanaRequest(userId, `/tasks/${encodeURIComponent(taskGid)}/addTag`, { method: "POST", body: JSON.stringify({ data: { tag: tagGid } }) });
    return "";
  } catch (error) {
    return error instanceof Error ? `Позначку Asana не додано: ${error.message}` : "Позначку Asana не додано";
  }
}

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
  const mayRead = mayEdit(user, node.acceptorId) || node.assigneeId === user.id || node.acceptorId === user.id || node.participantIds.includes(user.id);
  if (!mayRead || body.action !== "read" && !mayEdit(user, node.acceptorId) && node.assigneeId !== user.id) return jsonError("Недостатньо повноважень", 403);

  try {
    let result: AsanaTaskEnvelope;
    if (body.action === "read") {
      if (!body.taskGid) return jsonError("Не вказано GID задачі Asana", 400);
      result = await asanaRequest(
        user.id,
        `/tasks/${encodeURIComponent(body.taskGid)}?opt_fields=name,completed,due_on,start_on,assignee.name,assignee.email,permalink_url,modified_at,notes,projects.gid,projects.name,workspace.gid,workspace.name,followers.gid,followers.name,followers.email,tags.gid,tags.name`,
      ) as AsanaTaskEnvelope;
    } else if (body.action === "create") {
      if (!body.projectGid && !body.workspaceGid) return jsonError("Не вказано робочий простір Asana", 400);
      const db = await database();
      const connection = db ? await db.prepare("SELECT asana_user_gid FROM asana_connections WHERE user_id = ?").bind(user.id).first<{ asana_user_gid: string }>() : null;
      result = await asanaRequest(user.id, "/tasks?opt_fields=gid,name,completed,due_on,assignee.name,permalink_url,modified_at,workspace.gid,workspace.name,projects.gid,projects.name", {
        method: "POST",
        body: JSON.stringify({
          data: {
            name: primaryAsanaTitle(node),
            notes: body.description || `${node.code}\n\n${node.result}\n\nКритерій приймання: ${node.acceptanceCriteria}`,
            ...(body.projectGid ? { projects: [body.projectGid] } : { workspace: body.workspaceGid }),
            start_on: body.startOn && (body.dueOn || node.plannedEnd) ? body.startOn : undefined,
            due_on: body.dueOn || node.plannedEnd || undefined,
            assignee: connection?.asana_user_gid || undefined,
          },
        }),
      }) as AsanaTaskEnvelope;
    } else if (body.action === "rename") {
      if (!body.taskGid || body.taskGid !== node.asana.taskGid) return jsonError("Головну задачу Asana не визначено", 400);
      result = await asanaRequest(user.id, `/tasks/${encodeURIComponent(body.taskGid)}?opt_fields=gid,name,completed,due_on,assignee.name,permalink_url,modified_at,workspace.gid,workspace.name,projects.gid,projects.name`, {
        method: "PUT",
        body: JSON.stringify({ data: { name: primaryAsanaTitle(node) } }),
      }) as AsanaTaskEnvelope;
    } else {
      if (!body.taskGid) return jsonError("Не вказано GID задачі Asana", 400);
      const data: Record<string, unknown> = {};
      // Existing Asana task names are changed only by the explicit rename action.
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
    const tagWarning = body.action === "create" || body.action === "read" && (mayEdit(user, node.acceptorId) || node.assigneeId === user.id) ? await ensureManagementTag(user.id, taskGid, workspaceGid) : "";
    let storySync: { imported: number; partial: boolean; error?: string } = { imported: 0, partial: false };
    if (body.action === "read") {
      try {
        const comments = await readComments(user.id, taskGid);
        storySync = { imported: await persistAsanaComments(node.id, comments.stories), partial: comments.partial };
      }
      catch (error) { storySync.error = error instanceof Error ? error.message : "Коментарі Asana недоступні"; }
    }
    const db = await database();
    if (db) {
      await db
        .prepare("INSERT INTO sync_events (id, user_id, node_id, direction, status, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), user.id, node.id, body.action === "read" ? "asana_to_portal" : "portal_to_asana", "success", body.action, new Date().toISOString())
        .run();
    }
    return Response.json({ ...result, followerSync, workspaceGid, tagWarning, storySync });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Помилка синхронізації", 502);
  }
}
