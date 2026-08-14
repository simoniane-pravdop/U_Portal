import { database, loadState, runtimeEnv } from "../../../lib/server";
import { hashTelegramCode, sendTelegramMessage } from "../../../lib/telegram";

type TelegramMessage = {
  chat: { id: number };
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
};
type TelegramUpdate = { update_id?: number; message?: TelegramMessage };

const help = "Команди:\n/my — мої відкриті цілі, цикли й завдання\n/help — підказка\n/stop — від’єднати Telegram від порталу";

export async function POST(request: Request) {
  const configuredSecret = runtimeEnv().TELEGRAM_WEBHOOK_SECRET || "";
  const receivedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!configuredSecret || receivedSecret !== configuredSecret) return new Response("Forbidden", { status: 403 });
  const update = (await request.json().catch(() => ({}))) as TelegramUpdate;
  const message = update.message;
  if (!message?.chat?.id || !message.text) return Response.json({ ok: true });
  const db = await database();
  if (!db) return new Response("Database unavailable", { status: 503 });
  const chatId = String(message.chat.id);
  const text = message.text.trim();
  const start = text.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);

  if (start) {
    const code = start[1]?.trim();
    if (!code) { await sendTelegramMessage(chatId, `Відкрийте персональне посилання у Налаштуваннях Управлінського порталу.\n\n${help}`); return Response.json({ ok: true }); }
    const codeHash = await hashTelegramCode(code);
    const row = await db.prepare("SELECT user_id, expires_at, used_at FROM telegram_link_codes WHERE code_hash = ?").bind(codeHash).first<{ user_id: string; expires_at: string; used_at: string }>();
    const { state } = await loadState();
    const user = row ? state.users.find((candidate) => candidate.id === row.user_id && candidate.active) : undefined;
    if (!row || row.used_at || row.expires_at <= new Date().toISOString() || !user) { await sendTelegramMessage(chatId, "Посилання недійсне або строк його дії минув. Створіть нове в Налаштуваннях порталу."); return Response.json({ ok: true }); }
    const now = new Date().toISOString();
    await db.batch([
      db.prepare("DELETE FROM telegram_links WHERE chat_id = ? AND user_id <> ?").bind(chatId, user.id),
      db.prepare("INSERT INTO telegram_links (user_id, chat_id, telegram_user_id, telegram_username, active, linked_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(user_id) DO UPDATE SET chat_id=excluded.chat_id, telegram_user_id=excluded.telegram_user_id, telegram_username=excluded.telegram_username, active=1, updated_at=excluded.updated_at")
        .bind(user.id, chatId, String(message.from?.id || message.chat.id), message.from?.username || "", now, now),
      db.prepare("UPDATE telegram_link_codes SET used_at = ? WHERE code_hash = ?").bind(now, codeHash),
    ]);
    await sendTelegramMessage(chatId, `${user.name}, Telegram успішно підключено до Управлінського порталу.\n\n${help}`);
    return Response.json({ ok: true });
  }

  const link = await db.prepare("SELECT user_id FROM telegram_links WHERE chat_id = ? AND active = 1").bind(chatId).first<{ user_id: string }>();
  if (!link) { await sendTelegramMessage(chatId, "Цей чат не прив’язаний до порталу. Створіть персональне посилання в Налаштуваннях."); return Response.json({ ok: true }); }
  if (/^\/stop(?:@\w+)?$/i.test(text)) {
    await db.prepare("DELETE FROM telegram_links WHERE chat_id = ?").bind(chatId).run();
    await sendTelegramMessage(chatId, "Telegram від’єднано від Управлінського порталу.");
    return Response.json({ ok: true });
  }
  if (/^\/my(?:@\w+)?$/i.test(text)) {
    const { state } = await loadState();
    const mine = state.nodes.filter((node) => !node.archived && !["completed", "cancelled"].includes(node.lifecycle) && [node.ownerId, node.assigneeId, node.acceptorId].includes(link.user_id)).slice(0, 12);
    const body = mine.length ? mine.map((node) => `${node.code} · ${node.title} — ${node.progress}%${node.health === "normal" ? "" : ` · ${node.health === "blocked" ? "заблоковано" : "ризик"}`}`).join("\n") : "Відкритих об’єктів немає.";
    await sendTelegramMessage(chatId, `Моя робота\n\n${body}`);
    return Response.json({ ok: true });
  }
  await sendTelegramMessage(chatId, help);
  return Response.json({ ok: true });
}
