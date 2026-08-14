import { baseUrl, createSession, jsonError, loadState, parseCookies, runtimeEnv } from "../../../../lib/server";

type GoogleUser = { email?: string; name?: string; hd?: string; verified_email?: boolean };

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(request);
  const config = runtimeEnv();
  if (!code || !state || state !== cookies.google_oauth_state) return jsonError("Невірний стан Google-входу", 400);
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) return jsonError("Google-вхід не налаштовано", 503);

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${baseUrl(request)}/api/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResponse.ok) return jsonError("Google не підтвердив вхід", 401);
  const token = (await tokenResponse.json()) as { access_token?: string };
  if (!token.access_token) return jsonError("Google не повернув токен доступу", 401);

  const profileResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!profileResponse.ok) return jsonError("Не вдалося отримати профіль Google", 401);
  const profile = (await profileResponse.json()) as GoogleUser;
  if (!profile.email || profile.verified_email === false) return jsonError("Google-адресу не підтверджено", 403);
  if (config.GOOGLE_ALLOWED_DOMAIN && profile.hd !== config.GOOGLE_ALLOWED_DOMAIN) {
    return jsonError("Дозволено лише корпоративний Google-акаунт", 403);
  }

  const { state: portal } = await loadState();
  const user = portal.users.find((candidate) => candidate.active && candidate.email.toLowerCase() === profile.email!.toLowerCase());
  if (!user) return jsonError("Цей корпоративний акаунт ще не додано до порталу", 403);
  const sessionCookie = await createSession(request, { ...user, name: profile.name || user.name }, "google");
  if (!sessionCookie) return jsonError("Сховище сеансів недоступне", 503);
  return new Response(null, { status: 302, headers: { Location: baseUrl(request), "Set-Cookie": sessionCookie } });
}
