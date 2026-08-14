import { currentUser, database, jsonError, loadState, randomToken } from "../../../lib/server";
import { hashTelegramCode, sendTelegramMessage, telegramBot, telegramConfigured } from "../../../lib/telegram";

type LinkAction = { action?: "create_code" | "unlink" | "test" };

export async function POST(request: Request) {
  const { state } = await loadState();
  const user = await currentUser(request, state);
  if (!user) return jsonError("Потрібен вхід", 401);
  if (!telegramConfigured()) return jsonError("Telegram-бот ще не налаштований для цього середовища", 503);
  const body = (await request.json().catch(() => ({}))) as LinkAction;
  const db = await database();
  if (!db) return jsonError("База підключень недоступна", 503);

  if (body.action === "unlink") {
    await db.prepare("DELETE FROM telegram_links WHERE user_id = ?").bind(user.id).run();
    return Response.json({ connected: false });
  }
  if (body.action === "test") {
    const row = await db.prepare("SELECT chat_id FROM telegram_links WHERE user_id = ? AND active = 1").bind(user.id).first<{ chat_id: string }>();
    if (!row?.chat_id) return jsonError("Спочатку прив’яжіть Telegram", 400);
    await sendTelegramMessage(row.chat_id, `Тестове повідомлення\n\n${user.name}, зв’язок з Управлінським порталом працює.`);
    return Response.json({ sent: true });
  }
  if (body.action !== "create_code") return jsonError("Не вказано дію", 400);

  const code = randomToken(16);
  const codeHash = await hashTelegramCode(code);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  await db.batch([
    db.prepare("DELETE FROM telegram_link_codes WHERE user_id = ? OR expires_at < ?").bind(user.id, now.toISOString()),
    db.prepare("INSERT INTO telegram_link_codes (code_hash, user_id, expires_at, used_at, created_at) VALUES (?, ?, ?, '', ?)").bind(codeHash, user.id, expiresAt, now.toISOString()),
  ]);
  const bot = await telegramBot();
  if (!bot.username) return jsonError("Для бота не визначено ім’я користувача", 502);
  return Response.json({ expiresAt, deepLink: `https://t.me/${bot.username}?start=${code}`, botUsername: bot.username });
}
