import { baseUrl, database, loadState, runtimeEnv } from "../../../lib/server";
import { sendTelegramMessage, telegramConfigured } from "../../../lib/telegram";

function dateInZone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export async function POST(request: Request) {
  const secret = runtimeEnv().TELEGRAM_WEBHOOK_SECRET || "";
  if (!secret || request.headers.get("X-Portal-Scheduler-Secret") !== secret) return new Response("Forbidden", { status: 403 });
  if (!telegramConfigured()) return Response.json({ sent: 0 });
  const { state } = await loadState();
  const db = await database();
  if (!db) return new Response("Database unavailable", { status: 503 });
  const timezone = state.settings.timezone || "Europe/Kyiv";
  const today = dateInZone(new Date(), timezone);
  const tomorrow = dateInZone(new Date(Date.now() + 86_400_000), timezone);
  const candidates = state.nodes.filter((node) => node.kind === "task" && !node.archived && !["completed", "cancelled"].includes(node.lifecycle) && node.plannedEnd && node.plannedEnd <= tomorrow);
  let sent = 0;
  for (const node of candidates) {
    const link = await db.prepare("SELECT chat_id FROM telegram_links WHERE user_id = ? AND active = 1").bind(node.assigneeId).first<{ chat_id: string }>();
    if (!link?.chat_id) continue;
    const key = `reminder:${today}:${node.id}`;
    const duplicate = await db.prepare("SELECT id FROM telegram_events WHERE user_id = ? AND summary = ? LIMIT 1").bind(node.assigneeId, key).first();
    if (duplicate) continue;
    const deadline = node.plannedEnd < today ? `прострочено з ${node.plannedEnd}` : node.plannedEnd === today ? "строк сьогодні" : "строк завтра";
    try {
      await sendTelegramMessage(link.chat_id, `Нагадування про строк\n\n${node.code} · ${node.title}\n${deadline} · прогрес ${node.progress}%\n\n${baseUrl(request)}/?view=my`);
      await db.prepare("INSERT INTO telegram_events (id, user_id, direction, status, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), node.assigneeId, "portal_to_telegram", "success", key, new Date().toISOString()).run();
      sent += 1;
    } catch (cause) {
      await db.prepare("INSERT INTO telegram_events (id, user_id, direction, status, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), node.assigneeId, "portal_to_telegram", "error", `${key}: ${cause instanceof Error ? cause.message : "error"}`.slice(0, 300), new Date().toISOString()).run();
    }
  }
  return Response.json({ sent, checked: candidates.length, date: today });
}
