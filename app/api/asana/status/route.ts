import { currentUser, database, jsonError, loadState, runtimeEnv } from "../../../lib/server";

export async function GET(request: Request) {
  const { state } = await loadState();
  const user = await currentUser(request, state);
  if (!user) return jsonError("Потрібен вхід", 401);
  const db = await database();
  const row = db
    ? await db
        .prepare("SELECT asana_user_gid, asana_user_name, expires_at, scope, updated_at FROM asana_connections WHERE user_id = ?")
        .bind(user.id)
        .first()
    : null;
  return Response.json({
    configured: Boolean(runtimeEnv().ASANA_CLIENT_ID && runtimeEnv().ASANA_CLIENT_SECRET && runtimeEnv().TOKEN_ENCRYPTION_KEY),
    connected: Boolean(row),
    connection: row || null,
  });
}
