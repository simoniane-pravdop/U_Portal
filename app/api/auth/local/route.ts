import { cookieHeader, isLocal, jsonError, loadState } from "../../../lib/server";

export async function POST(request: Request) {
  if (!isLocal(request)) return jsonError("Локальне перемикання користувача вимкнене", 403);
  const { userId } = (await request.json()) as { userId?: string };
  const { state } = await loadState();
  if (!state.users.some((user) => user.id === userId && user.active)) return jsonError("Користувача не знайдено", 404);
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": cookieHeader("portal_local_user", userId || "", request, { maxAge: 60 * 60 * 24 * 30 }) } },
  );
}
