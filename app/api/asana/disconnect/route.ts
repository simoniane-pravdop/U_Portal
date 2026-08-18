import { decryptSecret } from "../../../lib/crypto";
import { cookieHeader, currentUser, database, jsonError, loadState, runtimeEnv } from "../../../lib/server";

export async function POST(request: Request) {
  const { state } = await loadState();
  const user = await currentUser(request, state);
  if (!user) return jsonError("Потрібен вхід", 401);
  const db = await database();
  if (!db) return jsonError("База підключень недоступна", 503);
  const connection = await db
    .prepare("SELECT encrypted_refresh_token FROM asana_connections WHERE user_id = ?")
    .bind(user.id)
    .first<{ encrypted_refresh_token: string }>();

  let revoked = false;
  if (connection?.encrypted_refresh_token) {
    const config = runtimeEnv();
    if (config.ASANA_CLIENT_ID && config.ASANA_CLIENT_SECRET) {
      try {
        const refreshToken = await decryptSecret(connection.encrypted_refresh_token);
        const response = await fetch("https://app.asana.com/-/oauth_revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: config.ASANA_CLIENT_ID, client_secret: config.ASANA_CLIENT_SECRET, token: refreshToken }),
        });
        revoked = response.ok;
      } catch {
        revoked = false;
      }
    }
  }

  await db.prepare("DELETE FROM asana_connections WHERE user_id = ?").bind(user.id).run();
  return Response.json(
    { disconnected: true, revoked, warning: connection && !revoked ? "Локальне підключення видалено; Asana не підтвердила відкликання токена." : "" },
    { headers: { "Cache-Control": "no-store", "Set-Cookie": cookieHeader("asana_oauth_state", "", request, { maxAge: 0 }) } },
  );
}
