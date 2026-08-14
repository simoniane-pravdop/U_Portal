import { cookieHeader } from "../../../lib/server";

export async function POST(request: Request) {
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": cookieHeader("mgmt_session", "", request, { maxAge: 0 }) } },
  );
}
