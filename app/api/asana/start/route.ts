import { baseUrl, cookieHeader, currentUser, jsonError, loadState, randomToken, runtimeEnv } from "../../../lib/server";

export async function GET(request: Request) {
  const { state } = await loadState();
  const user = await currentUser(request, state);
  if (!user) return jsonError("Потрібен вхід", 401);
  const config = runtimeEnv();
  if (!config.ASANA_CLIENT_ID || !config.ASANA_CLIENT_SECRET || !config.TOKEN_ENCRYPTION_KEY) {
    return jsonError("Asana ще не налаштована для цього середовища", 503);
  }
  const stateToken = randomToken(24);
  const params = new URLSearchParams({
    client_id: config.ASANA_CLIENT_ID,
    redirect_uri: `${baseUrl(request)}/api/asana/callback`,
    response_type: "code",
    state: stateToken,
    scope: "tasks:read tasks:write projects:read users:read",
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://app.asana.com/-/oauth_authorize?${params}`,
      "Set-Cookie": cookieHeader("asana_oauth_state", `${user.id}:${stateToken}`, request, { maxAge: 600 }),
    },
  });
}
