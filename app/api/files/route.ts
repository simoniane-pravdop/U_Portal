import { currentUser, jsonError, loadState, runtimeEnv } from "../../lib/server";

function safeFilename(value: string) {
  return value.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 120) || "file";
}

export async function POST(request: Request) {
  const { state } = await loadState();
  const user = await currentUser(request, state);
  if (!user) return jsonError("Потрібен вхід", 401);
  const bucket = runtimeEnv().FILES;
  if (!bucket) return jsonError("Сховище файлів не підключено", 503);
  const form = await request.formData();
  const file = form.get("file");
  const nodeId = String(form.get("nodeId") || "unassigned");
  if (!(file instanceof File)) return jsonError("Файл не вибрано", 400);
  if (file.size > 20 * 1024 * 1024) return jsonError("Максимальний розмір файлу — 20 МБ", 413);
  const key = `${safeFilename(nodeId)}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${safeFilename(file.name)}`;
  await bucket.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: { uploadedBy: user.email, originalName: file.name },
  });
  return Response.json({ key, name: file.name, url: `/api/files?key=${encodeURIComponent(key)}` });
}

export async function GET(request: Request) {
  const { state } = await loadState();
  const user = await currentUser(request, state);
  if (!user) return jsonError("Потрібен вхід", 401);
  const key = new URL(request.url).searchParams.get("key");
  if (!key || key.includes("..")) return jsonError("Некоректний ключ файлу", 400);
  const object = await runtimeEnv().FILES?.get(key);
  if (!object) return jsonError("Файл не знайдено", 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(object.customMetadata?.originalName || "file")}`);
  return new Response(object.body, { headers });
}

export async function DELETE(request: Request) {
  const { state } = await loadState();
  const user = await currentUser(request, state);
  if (!user) return jsonError("Потрібен вхід", 401);
  const key = new URL(request.url).searchParams.get("key");
  if (!key || key.includes("..")) return jsonError("Некоректний ключ файлу", 400);
  const bucket = runtimeEnv().FILES;
  const object = await bucket?.head(key);
  if (!object) return jsonError("Файл не знайдено", 404);
  if (user.role !== "admin" && object.customMetadata?.uploadedBy !== user.email) {
    return jsonError("Видалити файл може автор або адміністратор", 403);
  }
  await bucket?.delete(key);
  return Response.json({ ok: true });
}
