import { decryptSecret, encryptSecret } from "./crypto";
import { database, runtimeEnv } from "./server";

type ConnectionRow = {
  encrypted_access_token: string;
  encrypted_refresh_token: string;
  expires_at: string;
  scope: string;
};

export async function asanaAccessToken(userId: string) {
  const db = await database();
  if (!db) throw new Error("База підключень недоступна");
  const row = await db
    .prepare("SELECT encrypted_access_token, encrypted_refresh_token, expires_at, scope FROM asana_connections WHERE user_id = ?")
    .bind(userId)
    .first<ConnectionRow>();
  if (!row) throw new Error("Підключіть особистий Asana-акаунт");
  if (new Date(row.expires_at).getTime() > Date.now() + 60_000) return decryptSecret(row.encrypted_access_token);

  const config = runtimeEnv();
  if (!config.ASANA_CLIENT_ID || !config.ASANA_CLIENT_SECRET) throw new Error("Asana не налаштована");
  const refreshToken = await decryptSecret(row.encrypted_refresh_token);
  const response = await fetch("https://app.asana.com/-/oauth_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.ASANA_CLIENT_ID,
      client_secret: config.ASANA_CLIENT_SECRET,
    }),
  });
  if (!response.ok) throw new Error("Не вдалося оновити доступ Asana");
  const token = (await response.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  const nextRefresh = token.refresh_token || refreshToken;
  const expiresAt = new Date(Date.now() + (token.expires_in || 3600) * 1000).toISOString();
  await db
    .prepare("UPDATE asana_connections SET encrypted_access_token = ?, encrypted_refresh_token = ?, expires_at = ?, updated_at = ? WHERE user_id = ?")
    .bind(await encryptSecret(token.access_token), await encryptSecret(nextRefresh), expiresAt, new Date().toISOString(), userId)
    .run();
  return token.access_token;
}

export async function asanaRequest(userId: string, path: string, init: RequestInit = {}) {
  const token = await asanaAccessToken(userId);
  const response = await fetch(`https://app.asana.com/api/1.0${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Asana API: ${response.status} ${detail.slice(0, 240)}`);
  }
  return response.json();
}
