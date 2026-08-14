import { database, runtimeEnv } from "./server";

type TelegramResult<T> = { ok: boolean; result?: T; description?: string };

export type TelegramBot = { id: number; username?: string; first_name: string };
export type TelegramWebhookInfo = { url: string; pending_update_count: number; last_error_message?: string };

export function telegramConfigured() {
  const config = runtimeEnv();
  return Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_WEBHOOK_SECRET);
}

export async function telegramRequest<T>(method: string, body: Record<string, unknown> = {}) {
  const token = runtimeEnv().TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram-бот ще не налаштований");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as TelegramResult<T>;
  if (!response.ok || !result.ok || result.result === undefined) throw new Error(result.description || "Telegram не підтвердив операцію");
  return result.result;
}

export async function telegramBot() {
  return telegramRequest<TelegramBot>("getMe");
}

export async function telegramWebhookInfo() {
  return telegramRequest<TelegramWebhookInfo>("getWebhookInfo");
}

export async function setTelegramWebhook(target: string) {
  const secret = runtimeEnv().TELEGRAM_WEBHOOK_SECRET;
  if (!secret) throw new Error("Секрет перевірки Telegram-webhook не налаштований");
  return telegramRequest<boolean>("setWebhook", {
    url: target,
    secret_token: secret,
    allowed_updates: ["message"],
    drop_pending_updates: false,
  });
}

export async function sendTelegramMessage(chatId: string, text: string) {
  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 3900),
    disable_web_page_preview: true,
  });
}

export async function notifyTelegramUsers(userIds: string[], text: string) {
  if (!telegramConfigured() || !userIds.length) return;
  const db = await database();
  if (!db) return;
  const unique = [...new Set(userIds.filter(Boolean))];
  for (const userId of unique) {
    const row = await db.prepare("SELECT chat_id FROM telegram_links WHERE user_id = ? AND active = 1").bind(userId).first<{ chat_id: string }>();
    if (!row?.chat_id) continue;
    try {
      await sendTelegramMessage(row.chat_id, text);
      await db.prepare("INSERT INTO telegram_events (id, user_id, direction, status, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), userId, "portal_to_telegram", "success", text.slice(0, 300), new Date().toISOString()).run();
    } catch (cause) {
      await db.prepare("INSERT INTO telegram_events (id, user_id, direction, status, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), userId, "portal_to_telegram", "error", cause instanceof Error ? cause.message.slice(0, 300) : "Помилка повідомлення", new Date().toISOString()).run();
    }
  }
}

export async function hashTelegramCode(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
