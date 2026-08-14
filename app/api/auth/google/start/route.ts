import { baseUrl, cookieHeader, jsonError, randomToken, runtimeEnv } from "../../../../lib/server";

export async function GET(request: Request) {
  const config = runtimeEnv();
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    return jsonError("Google-вхід ще не налаштовано для цього середовища", 503);
  }
  const state = randomToken(24);
  const redirectUri = `${baseUrl(request)}/api/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  if (config.GOOGLE_ALLOWED_DOMAIN) params.set("hd", config.GOOGLE_ALLOWED_DOMAIN);
  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      "Set-Cookie": cookieHeader("google_oauth_state", state, request, { maxAge: 600 }),
    },
  });
}
