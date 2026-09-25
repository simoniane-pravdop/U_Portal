import { asanaRequest } from "./asana";
import { portalMessageForAsana, portalOriginId, portalReportForAsana } from "./asana-integration";
import { baseUrl, database, loadState } from "./server";
import type { DiscussionMessage, WorkUpdate } from "../types";

type OutboxRow = { event_id: string; node_id: string; task_gid: string; author_id: string; recipient_id: string; kind: string; payload: string };
type Story = { gid: string; text?: string; resource_subtype?: string };

async function existingStoryIds(userId: string, taskGid: string) {
  const ids = new Map<string, string>();
  let offset = "";
  for (let page = 0; page < 10; page += 1) {
    const params = new URLSearchParams({ limit: "100", opt_fields: "gid,text,resource_subtype" });
    if (offset) params.set("offset", offset);
    const result = await asanaRequest(userId, `/tasks/${encodeURIComponent(taskGid)}/stories?${params}`) as { data?: Story[]; next_page?: { offset?: string } | null };
    for (const story of result.data || []) {
      const id = portalOriginId(story.text || "");
      if (id) ids.set(id, story.gid);
    }
    offset = result.next_page?.offset || "";
    if (!offset) break;
  }
  return ids;
}

/** Deliver only events authored by the connected portal user, so Asana attribution stays truthful. */
export async function flushAsanaOutbox(request: Request, authorId: string, nodeId?: string) {
  const db = await database();
  if (!db) return { sent: 0, pending: 0, errors: [] as string[] };
  const rows = await db.prepare(`SELECT event_id, node_id, task_gid, author_id, recipient_id, kind, payload FROM asana_outbox WHERE author_id = ? AND status = 'pending' ${nodeId ? "AND node_id = ?" : ""} ORDER BY created_at LIMIT 3`)
    .bind(...(nodeId ? [authorId, nodeId] : [authorId])).all<OutboxRow>();
  const { state } = await loadState();
  const errors: string[] = [];
  let sent = 0;
  const storyCache = new Map<string, Map<string, string>>();
  for (const row of rows.results || []) {
    const node = state.nodes.find((item) => item.id === row.node_id);
    // Never send an old queued event to a task that has since been detached or replaced.
    if (!node || node.asana.taskGid !== row.task_gid) {
      await db.prepare("UPDATE asana_outbox SET status = 'cancelled', last_error = ? WHERE event_id = ?").bind("Головну задачу Asana змінено", row.event_id).run();
      continue;
    }
    try {
      if (!storyCache.has(row.task_gid)) storyCache.set(row.task_gid, await existingStoryIds(authorId, row.task_gid));
      const known = storyCache.get(row.task_gid)!;
      let storyGid = known.get(row.event_id) || "";
      if (!storyGid) {
        const author = state.users.find((item) => item.id === row.author_id);
        const payload = JSON.parse(row.payload) as WorkUpdate & DiscussionMessage;
        const focus = row.kind === "report" ? "reports" : payload.relatedType === "blocker" ? "blocker" : payload.relatedType === "decision" ? "decision" : payload.relatedType === "acceptance" ? "acceptance" : "discussion";
        const actionUrl = `${baseUrl(request)}/?view=my&node=${encodeURIComponent(node.id)}&focus=${focus}`;
        let htmlText: string;
        if (row.kind === "report") {
          htmlText = portalReportForAsana(payload, author?.name || "Учасник порталу", actionUrl);
        } else {
          const message = payload;
          let recipientGid = "";
          const recipient = state.users.find((item) => item.id === row.recipient_id && item.active);
          if (row.recipient_id && (!recipient?.email || !node.asana.workspaceGid)) {
            throw new Error("Для @згадки не знайдено активного адресата або робочого простору Asana");
          }
          if (recipient?.email && node.asana.workspaceGid) {
            const user = await asanaRequest(authorId, `/workspaces/${encodeURIComponent(node.asana.workspaceGid)}/users/${encodeURIComponent(recipient.email)}`) as { data?: { gid?: string } };
            recipientGid = user.data?.gid || "";
            if (!recipientGid) throw new Error(`Адресата ${recipient.email} не знайдено в робочому просторі Asana`);
            if (recipientGid) {
              const task = await asanaRequest(authorId, `/tasks/${encodeURIComponent(row.task_gid)}?opt_fields=assignee.gid,followers.gid`) as { data?: { assignee?: { gid?: string }; followers?: Array<{ gid?: string }> } };
              if (task.data?.assignee?.gid !== recipientGid && !task.data?.followers?.some((follower) => follower.gid === recipientGid)) {
                await asanaRequest(authorId, `/tasks/${encodeURIComponent(row.task_gid)}/addFollowers`, { method: "POST", body: JSON.stringify({ data: { followers: [recipientGid] } }) });
                await new Promise((resolve) => setTimeout(resolve, 3000));
              }
            }
          }
          htmlText = portalMessageForAsana(message, author?.name || "Учасник порталу", actionUrl, recipientGid);
        }
        const result = await asanaRequest(authorId, `/tasks/${encodeURIComponent(row.task_gid)}/stories?opt_fields=gid`, { method: "POST", body: JSON.stringify({ data: { html_text: htmlText } }) }) as { data?: { gid?: string } };
        storyGid = result.data?.gid || "";
        known.set(row.event_id, storyGid);
      }
      await db.prepare("UPDATE asana_outbox SET status = 'sent', story_gid = ?, sent_at = ?, last_error = '' WHERE event_id = ?").bind(storyGid, new Date().toISOString(), row.event_id).run();
      sent += 1;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Помилка Asana";
      errors.push(detail);
      await db.prepare("UPDATE asana_outbox SET last_error = ? WHERE event_id = ?").bind(detail.slice(0, 500), row.event_id).run();
      // No further attempts in this request after a permission or connection failure.
      break;
    }
  }
  const remaining = await db.prepare("SELECT COUNT(*) AS count FROM asana_outbox WHERE author_id = ? AND status = 'pending'").bind(authorId).first<{ count: number }>();
  return { sent, pending: remaining?.count || 0, errors };
}
