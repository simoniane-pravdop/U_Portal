import { baseUrl, currentUser, database, jsonError, loadState } from "../../lib/server";
import type { PortalIdea } from "../../types";

export const dynamic = "force-dynamic";

type IdeaRow = { id: string; title: string; description: string; created_by_id: string; created_at: string; updated_at: string; version: number };
function ideaFromRow(row: IdeaRow): PortalIdea {
  return { id: row.id, title: row.title, description: row.description, createdById: row.created_by_id, createdAt: row.created_at, updatedAt: row.updated_at, version: row.version };
}

export async function GET(request: Request) {
  const { state } = await loadState();
  if (!await currentUser(request, state)) return jsonError("Потрібен вхід", 401);
  const db = await database();
  if (!db) return jsonError("Сховище ідей недоступне", 503);
  const rows = await db.prepare("SELECT * FROM portal_ideas ORDER BY created_at DESC, id DESC").all<IdeaRow>();
  return Response.json({ ideas: (rows.results || []).map(ideaFromRow) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const { state } = await loadState();
  const user = await currentUser(request, state);
  if (!user) return jsonError("Потрібен вхід", 401);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(baseUrl(request)).origin) return jsonError("Недозволене джерело запиту", 403);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.title !== "string" || typeof body.description !== "string") return jsonError("Вкажіть назву та опис ідеї", 400);
  const title = body.title.trim();
  const description = body.description.trim();
  if (!title || title.length > 250 || description.length > 12000) return jsonError("Назва обов’язкова (до 250 символів), опис — до 12 000 символів", 400);
  if (body.id !== undefined && (typeof body.id !== "string" || !body.id)) return jsonError("Некоректна ідея", 400);
  const db = await database();
  if (!db) return jsonError("Сховище ідей недоступне", 503);
  const now = new Date().toISOString();
  const id = body.id || crypto.randomUUID();
  if (body.id) {
    const existing = await db.prepare("SELECT * FROM portal_ideas WHERE id = ?").bind(id).first<IdeaRow>();
    if (!existing) return jsonError("Ідею не знайдено", 404);
    if (existing.created_by_id !== user.id && !["owner", "admin"].includes(user.role)) return jsonError("Редагувати ідею може її автор або адміністратор", 403);
    if (!Number.isInteger(body.version) || body.version !== existing.version) return jsonError("Ідею вже змінив інший користувач. Ваш текст збережено у формі; перевірте актуальну версію перед повторним редагуванням.", 409);
    const saved = await db.prepare("UPDATE portal_ideas SET title = ?, description = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?").bind(title, description, now, id, body.version).run();
    if (!saved.meta.changes) return jsonError("Ідею вже змінив інший користувач. Ваш текст залишився у формі.", 409);
  } else {
    await db.prepare("INSERT INTO portal_ideas (id, title, description, created_by_id, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1)").bind(id, title, description, user.id, now, now).run();
  }
  const saved = await db.prepare("SELECT * FROM portal_ideas WHERE id = ?").bind(id).first<IdeaRow>();
  return Response.json({ idea: ideaFromRow(saved!) }, { status: body.id ? 200 : 201, headers: { "Cache-Control": "no-store" } });
}
