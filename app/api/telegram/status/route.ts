import { currentUser, database, jsonError, loadState } from "../../../lib/server";
import { telegramBot, telegramConfigured, telegramWebhookInfo } from "../../../lib/telegram";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { state } = await loadState();
  const user = await currentUser(request, state);
  if (!user) return jsonError("Потрібен вхід", 401);
  const db = await database();
  const connection = db ? await db.prepare("SELECT telegram_username, linked_at, updated_at FROM telegram_links WHERE user_id = ? AND active = 1").bind(user.id).first() : null;
  if (!telegramConfigured()) return Response.json({ configured: false, connected: Boolean(connection), connection });
  try {
    const [bot, webhook] = await Promise.all([telegramBot(), telegramWebhookInfo()]);
    return Response.json({ configured: true, connected: Boolean(connection), connection, bot: { username: bot.username || "", name: bot.first_name }, webhook: { active: Boolean(webhook.url), url: webhook.url, pending: webhook.pending_update_count, error: webhook.last_error_message || "" } });
  } catch (cause) {
    return Response.json({ configured: true, connected: Boolean(connection), connection, error: cause instanceof Error ? cause.message : "Не вдалося перевірити Telegram" });
  }
}
