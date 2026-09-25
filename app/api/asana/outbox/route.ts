import { flushAsanaOutbox } from "../../../lib/asana-outbox";
import { currentUser, database, jsonError, loadState } from "../../../lib/server";

export async function GET(request: Request) {
  const { state } = await loadState();
  const user = await currentUser(request, state);
  if (!user) return jsonError("Потрібен вхід", 401);
  const nodeId = new URL(request.url).searchParams.get("nodeId") || "";
  const db = await database();
  if (!db) return Response.json({ pending: 0, lastError: "" });
  const row = await db.prepare("SELECT COUNT(*) AS pending FROM asana_outbox WHERE author_id = ? AND node_id = ? AND status = 'pending'")
    .bind(user.id, nodeId).first<{ pending: number }>();
  const latest = await db.prepare("SELECT last_error AS lastError FROM asana_outbox WHERE author_id = ? AND node_id = ? AND status = 'pending' AND last_error <> '' ORDER BY created_at DESC LIMIT 1")
    .bind(user.id, nodeId).first<{ lastError: string }>();
  return Response.json({ pending: row?.pending || 0, lastError: latest?.lastError || "" });
}

export async function POST(request: Request) {
  const { state } = await loadState();
  const user = await currentUser(request, state);
  if (!user) return jsonError("Потрібен вхід", 401);
  const body = await request.json() as { nodeId?: string };
  const node = state.nodes.find((item) => item.id === body.nodeId);
  if (!node) return jsonError("Картку не знайдено", 404);
  try {
    return Response.json(await flushAsanaOutbox(request, user.id, node.id));
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Не вдалося повторити синхронізацію", 502);
  }
}
