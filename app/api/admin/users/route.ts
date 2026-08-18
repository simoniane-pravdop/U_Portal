import {
  currentUser,
  database,
  hashPassword,
  jsonError,
  loadState,
  runtimeEnv,
  validatePassword,
} from "../../../lib/server";
import type { PortalPayload, PortalRole, PortalState, PortalUser } from "../../../types";

export const dynamic = "force-dynamic";

type UserAction = {
  action?: "create" | "update" | "reset_password" | "toggle_active";
  expectedRevision?: number;
  userId?: string;
  name?: string;
  email?: string;
  role?: PortalRole;
  password?: string;
};

const assignableRoles: PortalRole[] = ["admin", "goal_owner", "cycle_owner", "coordinator", "executor", "viewer"];

function mayManage(actor: PortalUser, target?: PortalUser) {
  if (actor.role === "owner") return true;
  return actor.role === "admin" && target?.role !== "owner" && target?.role !== "admin";
}

function publicPayload(state: PortalState, actor: PortalPayload["currentUser"], storage: PortalPayload["storage"]) {
  return {
    ...state,
    currentUser: actor,
    storage,
    authConfigured: Boolean(runtimeEnv().PORTAL_OWNER_CREDENTIAL || runtimeEnv().GOOGLE_CLIENT_ID),
  };
}

export async function POST(request: Request) {
  const { state: current, storage } = await loadState();
  const actor = await currentUser(request, current);
  if (!actor) return jsonError("Потрібен вхід", 401);
  if (!['owner', 'admin'].includes(actor.role)) return jsonError("Керування доступом дозволено лише власнику або адміністратору порталу", 403);
  if (!runtimeEnv().PORTAL_PASSWORD_PEPPER) return jsonError("Захист паролів ще не налаштовано", 503);

  const body = (await request.json().catch(() => ({}))) as UserAction;
  if (!body.action) return jsonError("Не вказано дію", 400);
  const db = await database();
  if (!db) return jsonError("Сховище облікових записів недоступне", 503);

  const next = structuredClone(current);
  const target = body.userId ? next.users.find((user) => user.id === body.userId) : undefined;
  if (body.action !== "create" && !target) return jsonError("Користувача не знайдено", 404);
  if (target?.role === "owner") return jsonError("Обліковий запис власника порталу захищений від змін", 403);
  if (body.action !== "create" && !mayManage(actor, target)) return jsonError("Недостатньо повноважень для цього користувача", 403);

  let actionLabel = "Оновлено доступ користувача";
  const entityId = target?.id || crypto.randomUUID();
  let credentialStatement: D1PreparedStatement | null = null;
  const followUpStatements: D1PreparedStatement[] = [];
  const now = new Date().toISOString();

  if (body.action === "create") {
    const name = body.name?.trim() || "";
    const email = body.email?.trim().toLowerCase() || "";
    const role = body.role || "executor";
    const passwordError = validatePassword(body.password || "");
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) return jsonError("Вкажіть ім’я та коректну корпоративну адресу", 400);
    if (next.users.some((user) => user.email.toLowerCase() === email)) return jsonError("Користувач із такою адресою вже існує", 409);
    if (!assignableRoles.includes(role) || actor.role !== "owner" && role === "admin") return jsonError("Цю роль не можна призначити", 403);
    if (passwordError) return jsonError(passwordError, 400);
    const user: PortalUser = { id: entityId, name, email, role, active: true, color: "#526f8f" };
    next.users.push(user);
    const credential = await hashPassword(body.password || "");
    credentialStatement = db.prepare(
      "INSERT INTO portal_credentials (user_id, email, password_hash, password_salt, password_iterations, must_change_password, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)",
    ).bind(user.id, user.email, credential.passwordHash, credential.passwordSalt, credential.passwordIterations, now, now, actor.email);
    actionLabel = `Додано користувача ${name}`;
  }

  if (body.action === "update" && target) {
    const name = body.name?.trim() || target.name;
    const email = body.email?.trim().toLowerCase() || target.email;
    const role = body.role || target.role;
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) return jsonError("Вкажіть ім’я та коректну корпоративну адресу", 400);
    if (next.users.some((user) => user.id !== target.id && user.email.toLowerCase() === email)) return jsonError("Користувач із такою адресою вже існує", 409);
    if (!assignableRoles.includes(role) || actor.role !== "owner" && role === "admin") return jsonError("Цю роль не можна призначити", 403);
    target.name = name;
    target.email = email;
    target.role = role;
    followUpStatements.push(db.prepare("UPDATE portal_credentials SET email = ?, updated_at = ? WHERE user_id = ?").bind(email, now, target.id));
    followUpStatements.push(db.prepare("DELETE FROM portal_sessions WHERE user_id = ? AND user_id <> ?").bind(target.id, actor.id));
    actionLabel = `Оновлено права ${name}`;
  }

  if (body.action === "toggle_active" && target) {
    if (target.id === actor.id) return jsonError("Не можна вимкнути власний обліковий запис", 400);
    target.active = !target.active;
    if (!target.active) followUpStatements.push(db.prepare("DELETE FROM portal_sessions WHERE user_id = ?").bind(target.id));
    actionLabel = target.active ? `Активовано ${target.name}` : `Вимкнено ${target.name}`;
  }

  if (body.action === "reset_password" && target) {
    const passwordError = validatePassword(body.password || "");
    if (passwordError) return jsonError(passwordError, 400);
    const credential = await hashPassword(body.password || "");
    credentialStatement = db.prepare(
      "INSERT INTO portal_credentials (user_id, email, password_hash, password_salt, password_iterations, must_change_password, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, password_hash = excluded.password_hash, password_salt = excluded.password_salt, password_iterations = excluded.password_iterations, must_change_password = 0, updated_at = excluded.updated_at, created_by = excluded.created_by",
    ).bind(target.id, target.email.toLowerCase(), credential.passwordHash, credential.passwordSalt, credential.passwordIterations, now, now, actor.email);
    followUpStatements.push(db.prepare("DELETE FROM portal_sessions WHERE user_id = ? AND user_id <> ?").bind(target.id, actor.id));
    actionLabel = `Створено новий пароль для ${target.name}`;
  }

  const notificationTarget = next.users.find((candidate) => candidate.id === entityId);
  if (notificationTarget && notificationTarget.id !== actor.id) {
    next.notifications = Array.isArray(next.notifications) ? next.notifications : [];
    next.notifications.unshift({
      id: crypto.randomUUID(),
      userId: notificationTarget.id,
      actorId: actor.id,
      nodeId: "",
      type: body.action === "create" ? "created" : "updated",
      title: body.action === "create" ? "Створено ваш доступ до порталу" : "Оновлено ваш обліковий запис",
      detail: actionLabel,
      createdAt: now,
      readAt: "",
    });
    next.notifications = next.notifications.slice(0, 1000);
  }

  next.version = Math.max(2, next.version || 2);
  next.revision = current.revision + 1;
  next.audit = [{ id: crypto.randomUUID(), at: now, by: actor.name, action: actionLabel, entityId }, ...next.audit].slice(0, 500);
  const stateStatement = db.prepare(
    "UPDATE portal_state SET payload = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ? AND revision = ?",
  ).bind(JSON.stringify(next), next.revision, now, actor.email, "main", current.revision);
  const results = await db.batch([stateStatement, ...(credentialStatement ? [credentialStatement] : []), ...followUpStatements]);
  if (!results[0].meta.changes) return jsonError("Конфлікт одночасного редагування", 409);
  return Response.json(publicPayload(next, actor, storage), { headers: { "Cache-Control": "no-store" } });
}
