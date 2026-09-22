import { asanaRequest } from "../../../lib/asana";
import { asanaLinks, asanaTaskGid } from "../../../lib/asana-links";
import { currentUser, database, jsonError, loadState } from "../../../lib/server";

export const dynamic = "force-dynamic";

type CachedTitle = { task_gid: string; name: string; updated_at: string };

export async function GET(request: Request) {
  const { state } = await loadState();
  const user = await currentUser(request, state);
  if (!user || !user.active) return jsonError("Потрібен вхід", 401);

  const nodeId = new URL(request.url).searchParams.get("nodeId") || "";
  const node = state.nodes.find((item) => item.id === nodeId);
  if (!node) return jsonError("Картку не знайдено", 404);

  const links = asanaLinks(node.controlPlace, node.description, node.asana.taskUrl, ...node.evidence.map((item) => item.value));
  const gidByUrl = new Map(links.map((url) => [url, asanaTaskGid(url)]).filter((entry): entry is [string, string] => Boolean(entry[1])));
  const gids = [...new Set(gidByUrl.values())].slice(0, 10);
  const names = new Map<string, string>();
  if (node.asana.taskGid && node.asana.remoteName) names.set(node.asana.taskGid, node.asana.remoteName);

  const db = await database();
  const cached = db && gids.length ? await db.prepare(`SELECT task_gid, name, updated_at FROM asana_task_titles WHERE task_gid IN (${gids.map(() => "?").join(",")})`).bind(...gids).all<CachedTitle>() : null;
  const fetchedAt = new Map<string, string>();
  for (const row of cached?.results || []) {
    names.set(row.task_gid, row.name);
    fetchedAt.set(row.task_gid, row.updated_at);
  }

  const connected = db ? await db.prepare("SELECT user_id FROM asana_connections WHERE user_id = ?").bind(user.id).first<{ user_id: string }>() : null;
  if (connected) {
    const staleBefore = Date.now() - 24 * 60 * 60 * 1000;
    const toRefresh = gids.filter((gid) => !fetchedAt.has(gid) || new Date(fetchedAt.get(gid)!).getTime() < staleBefore).slice(0, 5);
    for (const gid of toRefresh) {
      try {
        const response = await asanaRequest(user.id, `/tasks/${encodeURIComponent(gid)}?opt_fields=name`) as { data?: { name?: string } };
        const name = response.data?.name?.trim();
        if (!name) continue;
        names.set(gid, name);
        await db!.prepare("INSERT INTO asana_task_titles (task_gid, name, updated_at) VALUES (?, ?, ?) ON CONFLICT(task_gid) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at")
          .bind(gid, name, new Date().toISOString()).run();
      } catch { /* Keep the last known name when this user cannot open a task. */ }
    }
  }

  const titles = Object.fromEntries([...gidByUrl].filter(([, gid]) => names.has(gid)).map(([url, gid]) => [url, names.get(gid)!]));
  return Response.json({ titles }, { headers: { "Cache-Control": "private, no-store" } });
}
