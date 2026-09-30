import { encryptSecret } from "../../../lib/crypto";
import { baseUrl, currentUser, database, jsonError, loadState, runtimeEnv } from "../../../lib/server";

export const dynamic = "force-dynamic";

function available() {
  return typeof process !== "undefined" && Boolean(process.env.PORTAL_SQLITE_PATH);
}

async function administrator(request: Request) {
  const { state } = await loadState();
  const user = await currentUser(request, state);
  return user && ["owner", "admin"].includes(user.role) ? user : null;
}

export async function GET(request: Request) {
  if (!await administrator(request)) return jsonError("Доступно лише адміністраторам", 403);
  const config = runtimeEnv();
  return Response.json({
    editable: available() && Boolean(config.TOKEN_ENCRYPTION_KEY),
    asana: {
      clientId: config.ASANA_CLIENT_ID || "",
      secretSet: Boolean(config.ASANA_CLIENT_SECRET),
      callbackUrl: `${baseUrl(request)}/api/asana/callback`,
    },
    telegram: {
      tokenSet: Boolean(config.TELEGRAM_BOT_TOKEN),
      webhookSecretSet: Boolean(config.TELEGRAM_WEBHOOK_SECRET),
      webhookUrl: `${baseUrl(request)}/api/telegram/webhook`,
    },
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const actor = await administrator(request);
  if (!actor) return jsonError("Доступно лише адміністраторам", 403);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(baseUrl(request)).origin) return jsonError("Недозволене джерело запиту", 403);
  if (!available() || !runtimeEnv().TOKEN_ENCRYPTION_KEY) return jsonError("Серверний ключ захисту інтеграцій не налаштований", 503);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const provider = body.provider;
  if (provider !== "asana" && provider !== "telegram") return jsonError("Невідома інтеграція", 400);
  const changes: Array<[string, string]> = [];
  if (provider === "asana") {
    const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
    const secret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
    if (clientId && !/^\d{10,30}$/.test(clientId)) return jsonError("Некоректний ідентифікатор застосунку Asana", 400);
    if (secret && (secret.length < 16 || secret.length > 256)) return jsonError("Некоректний секрет застосунку Asana", 400);
    if (clientId) changes.push(["ASANA_CLIENT_ID", clientId]);
    if (secret) changes.push(["ASANA_CLIENT_SECRET", secret]);
  } else {
    const token = typeof body.botToken === "string" ? body.botToken.trim() : "";
    if (token && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) return jsonError("Некоректний токен Telegram-бота", 400);
    if (token) changes.push(["TELEGRAM_BOT_TOKEN", token]);
    if (token && !runtimeEnv().TELEGRAM_WEBHOOK_SECRET) {
      changes.push(["TELEGRAM_WEBHOOK_SECRET", crypto.randomUUID().replaceAll("-", "")]);
    }
  }
  if (!changes.length) return jsonError("Заповніть хоча б одне поле для оновлення", 400);
  const db = await database();
  if (!db) return jsonError("База даних недоступна", 503);
  const now = new Date().toISOString();
  await db.batch(await Promise.all(changes.map(async ([name, value]) => db.prepare(
    `INSERT INTO portal_integration_settings (name, encrypted_value, updated_by, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET encrypted_value=excluded.encrypted_value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
  ).bind(name, await encryptSecret(value), actor.id, now))));
  return Response.json({ saved: true, provider }, { headers: { "Cache-Control": "no-store" } });
}
