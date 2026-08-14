import { encryptSecret } from "../../../lib/crypto";
import { baseUrl, currentUser, database, jsonError, loadState, parseCookies, runtimeEnv } from "../../../lib/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateToken = url.searchParams.get("state");
  const cookies = parseCookies(request);
  const { state } = await loadState();
  const user = await currentUser(request, state);
  if (!user || !code || !stateToken || cookies.asana_oauth_state !== `${user.id}:${stateToken}`) {
    return jsonError("Невірний стан підключення Asana", 400);
  }
  const config = runtimeEnv();
  if (!config.ASANA_CLIENT_ID || !config.ASANA_CLIENT_SECRET) return jsonError("Asana не налаштована", 503);

  const tokenResponse = await fetch("https://app.asana.com/-/oauth_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.ASANA_CLIENT_ID,
      client_secret: config.ASANA_CLIENT_SECRET,
      redirect_uri: `${baseUrl(request)}/api/asana/callback`,
      code,
    }),
  });
  if (!tokenResponse.ok) return jsonError("Asana не підтвердила підключення", 401);
  const token = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    data?: { gid?: string; id?: string; name?: string };
  };
  if (!token.access_token || !token.refresh_token) return jsonError("Asana не повернула потрібні токени", 401);

  const db = await database();
  if (!db) return jsonError("База підключень недоступна", 503);
  const expiresAt = new Date(Date.now() + (token.expires_in || 3600) * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO asana_connections
        (user_id, asana_user_gid, asana_user_name, encrypted_access_token, encrypted_refresh_token, expires_at, scope, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
        asana_user_gid=excluded.asana_user_gid,
        asana_user_name=excluded.asana_user_name,
        encrypted_access_token=excluded.encrypted_access_token,
        encrypted_refresh_token=excluded.encrypted_refresh_token,
        expires_at=excluded.expires_at,
        scope=excluded.scope,
        updated_at=excluded.updated_at`,
    )
    .bind(
      user.id,
      token.data?.gid || token.data?.id || "unknown",
      token.data?.name || user.name,
      await encryptSecret(token.access_token),
      await encryptSecret(token.refresh_token),
      expiresAt,
      token.scope || "",
      new Date().toISOString(),
    )
    .run();
  return new Response(null, { status: 302, headers: { Location: `${baseUrl(request)}/?view=settings&asana=connected` } });
}
