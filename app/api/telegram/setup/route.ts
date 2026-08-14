import { baseUrl, currentUser, jsonError, loadState } from "../../../lib/server";
import { setTelegramWebhook, telegramConfigured, telegramWebhookInfo } from "../../../lib/telegram";

export async function POST(request: Request) {
  const { state } = await loadState();
  const user = await currentUser(request, state);
  if (!user) return jsonError("Потрібен вхід", 401);
  if (!["owner", "admin"].includes(user.role)) return jsonError("Налаштувати бот може лише власник або адміністратор", 403);
  if (!telegramConfigured()) return jsonError("Додайте токен бота і секрет webhook до середовища", 503);
  await setTelegramWebhook(`${baseUrl(request)}/api/telegram/webhook`);
  const webhook = await telegramWebhookInfo();
  return Response.json({ active: Boolean(webhook.url), url: webhook.url, pending: webhook.pending_update_count, error: webhook.last_error_message || "" });
}
