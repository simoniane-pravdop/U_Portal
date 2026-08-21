import { baseUrl, currentUser, database, jsonError, loadState, mayEdit, runtimeEnv } from "../../lib/server";
import { notifyTelegramUsers } from "../../lib/telegram";
import type { PortalNotification, PortalState } from "../../types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { state, storage } = await loadState();
  const user = await currentUser(request, state);
  if (!user) return jsonError("Потрібен вхід за корпоративною адресою", 401);
  return Response.json(
    {
      ...state,
      currentUser: user,
      storage,
      authConfigured: Boolean(runtimeEnv().PORTAL_OWNER_CREDENTIAL || runtimeEnv().GOOGLE_CLIENT_ID),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const { state: current, storage } = await loadState();
  const user = await currentUser(request, current);
  if (!user) return jsonError("Потрібен вхід", 401);

  const body = (await request.json()) as { state?: PortalState; expectedRevision?: number; action?: string; entityId?: string };
  if (!body.state || !Array.isArray(body.state.nodes) || !Array.isArray(body.state.users)) {
    return jsonError("Некоректна структура стану", 400);
  }
  if (JSON.stringify(body.state.users) !== JSON.stringify(current.users)) {
    return jsonError("Користувачі та права змінюються лише в налаштуваннях порталу", 403);
  }
  if (JSON.stringify(body.state.audit) !== JSON.stringify(current.audit)) {
    return jsonError("Журнал змін формується сервером і не може редагуватися вручну", 403);
  }
  if (JSON.stringify(body.state.settings) !== JSON.stringify(current.settings) && !["owner", "admin"].includes(user.role)) {
    return jsonError("Налаштування порталу може змінювати лише власник або адміністратор", 403);
  }

  const nodeIds = new Set([...current.nodes.map((node) => node.id), ...body.state.nodes.map((node) => node.id)]);
  const changedNodeIds = [...nodeIds].filter((id) => {
    const before = current.nodes.find((node) => node.id === id);
    const after = body.state!.nodes.find((node) => node.id === id);
    return JSON.stringify(before) !== JSON.stringify(after);
  });
  for (const id of changedNodeIds) {
    const before = current.nodes.find((node) => node.id === id);
    const after = body.state.nodes.find((node) => node.id === id);
    if (!after) return jsonError("Записи не видаляються фізично — використайте контрольоване вилучення з дерева", 400);
    const mayCreate = !before && ["owner", "admin", "goal_owner", "cycle_owner", "coordinator"].includes(user.role);
    const mayChange = before && (mayEdit(user, before.ownerId) || before.assigneeId === user.id || before.acceptorId === user.id);
    if (!mayCreate && !mayChange) return jsonError("Недостатньо повноважень для однієї зі змін", 403);
  }

  const affectedNodeIds = new Set<string>();
  const collectChanged = <T extends { id: string }>(before: T[], after: T[], nodeIdsFor: (item: T) => string[]) => {
    const ids = new Set([...before.map((item) => item.id), ...after.map((item) => item.id)]);
    for (const id of ids) {
      const oldItem = before.find((item) => item.id === id);
      const newItem = after.find((item) => item.id === id);
      if (JSON.stringify(oldItem) !== JSON.stringify(newItem)) {
        for (const nodeId of nodeIdsFor(newItem || oldItem!)) affectedNodeIds.add(nodeId);
      }
    }
  };
  collectChanged(current.dependencies, body.state.dependencies, (item) => [item.predecessorId, item.successorId]);
  collectChanged(current.blockers, body.state.blockers, (item) => [item.nodeId]);
  collectChanged(current.decisions, body.state.decisions, (item) => [item.nodeId]);
  collectChanged(current.acceptances, body.state.acceptances, (item) => [item.nodeId]);
  collectChanged(current.coordinations, body.state.coordinations, (item) => [item.cycleId || item.subcycleId]);
  const discussionIds = new Set([...(current.discussions || []).map((item) => item.id), ...(body.state.discussions || []).map((item) => item.id)]);
  for (const id of discussionIds) {
    const before = (current.discussions || []).find((item) => item.id === id);
    const after = (body.state.discussions || []).find((item) => item.id === id);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const nodeId = after?.nodeId || before?.nodeId;
    const node = current.nodes.find((candidate) => candidate.id === nodeId) || body.state.nodes.find((candidate) => candidate.id === nodeId);
    const addressed = [...(current.discussions || []), ...(body.state.discussions || [])].some((message) => message.nodeId === nodeId && message.recipientId === user.id);
    const authored = before?.authorId === user.id || after?.authorId === user.id;
    if (!node || !(mayEdit(user, node.ownerId) || node.assigneeId === user.id || node.acceptorId === user.id || node.participantIds.includes(user.id) || addressed || authored)) {
      return jsonError("Недостатньо повноважень для повідомлення в цій картці", 403);
    }
  }
  const currentNotifications = Array.isArray(current.notifications) ? current.notifications : [];
  const submittedNotifications = Array.isArray(body.state.notifications) ? body.state.notifications : [];
  if (submittedNotifications.length !== currentNotifications.length) return jsonError("Нові сповіщення формуються системою", 403);
  for (const submitted of submittedNotifications) {
    const existing = currentNotifications.find((item) => item.id === submitted.id);
    if (!existing) return jsonError("Невідоме сповіщення", 403);
    const { readAt: existingReadAt, ...existingStable } = existing;
    const { readAt: submittedReadAt, ...submittedStable } = submitted;
    if (JSON.stringify(existingStable) !== JSON.stringify(submittedStable) || existing.userId !== user.id && existingReadAt !== submittedReadAt || existingReadAt && !submittedReadAt) {
      return jsonError("Можна змінювати лише стан власного сповіщення", 403);
    }
  }
  for (const id of affectedNodeIds) {
    const node = current.nodes.find((candidate) => candidate.id === id) || body.state.nodes.find((candidate) => candidate.id === id);
    const decides = [...current.decisions, ...body.state.decisions].some((decision) => decision.nodeId === id && decision.decisionOwnerId === user.id);
    if (!node || !(mayEdit(user, node.ownerId) || node.assigneeId === user.id || node.acceptorId === user.id || decides)) {
      return jsonError("Недостатньо повноважень для пов’язаної зміни", 403);
    }
  }
  if (body.expectedRevision !== current.revision) {
    return Response.json(
      { error: "Дані вже змінив інший користувач", currentRevision: current.revision },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  const db = await database();
  if (db && body.action?.startsWith("Оновлено ") && body.entityId) {
    const now = new Date().toISOString();
    const lock = await db.prepare("SELECT user_id, user_name, expires_at FROM portal_edit_locks WHERE entity_id = ? AND expires_at > ?").bind(body.entityId, now).first<{ user_id: string; user_name: string; expires_at: string }>();
    if (lock && lock.user_id !== user.id) return jsonError(`${lock.user_name} зараз редагує цю картку. Дочекайтеся завершення або оновіть дані.`, 423);
  }

  const next = body.state;
  next.notifications = submittedNotifications;
  if (!body.action?.startsWith("Сповіщення")) {
    const notifiedUsers = new Set<string>();
    const addNotification = (userId: string | undefined, nodeId: string, type: PortalNotification["type"], title: string, detail: string) => {
      if (!userId || userId === user.id || notifiedUsers.has(userId) || !next.users.some((candidate) => candidate.id === userId && candidate.active)) return;
      next.notifications.unshift({ id: crypto.randomUUID(), userId, actorId: user.id, nodeId, type, title, detail, createdAt: new Date().toISOString(), readAt: "" });
      notifiedUsers.add(userId);
    };
    const relatedUsers = (nodeId: string) => {
      const node = next.nodes.find((candidate) => candidate.id === nodeId);
      return node ? [...new Set([node.ownerId, node.assigneeId, node.acceptorId, ...node.participantIds])] : [];
    };
    const newMessages = (next.discussions || []).filter((message) => !(current.discussions || []).some((existing) => existing.id === message.id));
    for (const message of newMessages) {
      const node = next.nodes.find((candidate) => candidate.id === message.nodeId);
      const recipients = message.recipientId ? [message.recipientId] : relatedUsers(message.nodeId);
      const type: PortalNotification["type"] = message.kind === "question" ? "question" : message.kind === "decision" ? "decision" : message.kind === "approval" ? "acceptance" : "comment";
      const title = message.kind === "question" ? `Нове питання · ${node?.code || "картка"}` : message.kind === "decision" ? `Запит рішення · ${node?.code || "картка"}` : message.kind === "approval" ? `Погодження · ${node?.code || "картка"}` : `Новий коментар · ${node?.code || "картка"}`;
      for (const recipientId of recipients) addNotification(recipientId, message.nodeId, type, title, message.text);
    }
    for (const acceptance of next.acceptances) {
      const before = current.acceptances.find((item) => item.id === acceptance.id);
      const node = next.nodes.find((candidate) => candidate.id === acceptance.nodeId);
      if (!before) addNotification(acceptance.acceptorId, acceptance.nodeId, "acceptance", `Результат очікує приймання · ${node?.code || "картка"}`, node?.title || acceptance.evidenceNote);
      else if (before.status !== acceptance.status) addNotification(acceptance.submittedBy, acceptance.nodeId, "acceptance", acceptance.status === "accepted" ? `Результат прийнято · ${node?.code || "картка"}` : `Результат повернуто · ${node?.code || "картка"}`, acceptance.feedback);
    }
    for (const decision of next.decisions) {
      const before = current.decisions.find((item) => item.id === decision.id);
      const node = next.nodes.find((candidate) => candidate.id === decision.nodeId);
      if (!before) addNotification(decision.decisionOwnerId, decision.nodeId, "decision", `Потрібне рішення · ${node?.code || "картка"}`, decision.question);
      else if (before.status !== decision.status) {
        const requester = (current.discussions || []).find((message) => message.relatedType === "decision" && message.relatedId === decision.id)?.authorId;
        addNotification(requester, decision.nodeId, "decision", `Рішення прийнято · ${node?.code || "картка"}`, decision.resolution);
      }
    }
    for (const id of changedNodeIds) {
      const before = current.nodes.find((node) => node.id === id);
      const after = next.nodes.find((node) => node.id === id);
      if (!after) continue;
      const recipients = [...new Set([after.ownerId, after.assigneeId, after.acceptorId, ...after.participantIds])];
      for (const recipientId of recipients) {
        const delegated = recipientId === after.assigneeId && before?.assigneeId !== after.assigneeId;
        const type: PortalNotification["type"] = !before ? "created" : delegated ? "delegation" : before.lifecycle !== "completed" && after.lifecycle === "completed" ? "completed" : "updated";
        const title = !before ? `Створено ${after.code}` : delegated ? `Вам делеговано ${after.code}` : type === "completed" ? `Завершено ${after.code}` : `${after.code}: ${body.action || "оновлено"}`;
        addNotification(recipientId, after.id, type, title, after.title);
      }
    }
    next.notifications = next.notifications.slice(0, 1000);
  }
  next.revision = current.revision + 1;
  next.version = Math.max(2, next.version || 2);
  next.audit = [
    {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      by: user.name,
      action: body.action || "Оновлено дані порталу",
      entityId: body.entityId || "portal",
    },
    ...(Array.isArray(next.audit) ? next.audit : []),
  ].slice(0, 500);

  if (db) {
    const now = new Date().toISOString();
    const stateStatement = db.prepare(
        "UPDATE portal_state SET payload = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ? AND revision = ?",
      )
      .bind(JSON.stringify(next), next.revision, now, user.email, "main", current.revision);
    const versions = changedNodeIds.map((id) => {
      const snapshot = next.nodes.find((node) => node.id === id);
      return db.prepare("INSERT INTO portal_entity_versions (id, entity_id, revision, user_id, user_name, action, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), id, next.revision, user.id, user.name, body.action || "Оновлено дані порталу", JSON.stringify(snapshot || null), now);
    });
    const results = await db.batch([stateStatement, ...versions]);
    if (!results[0].meta.changes) return jsonError("Конфлікт одночасного редагування", 409);
  }

  if (next.settings.telegramPlanned) {
    const entityId = body.entityId || changedNodeIds[0] || [...affectedNodeIds][0];
    const node = entityId ? next.nodes.find((candidate) => candidate.id === entityId) : undefined;
    if (node) {
      const createdBlocker = next.blockers.find((item) => item.nodeId === node.id && !current.blockers.some((before) => before.id === item.id));
      const createdDecision = next.decisions.find((item) => item.nodeId === node.id && !current.decisions.some((before) => before.id === item.id));
      const createdAcceptance = next.acceptances.find((item) => item.nodeId === node.id && !current.acceptances.some((before) => before.id === item.id));
      const beforeNode = current.nodes.find((candidate) => candidate.id === node.id);
      const becameUnhealthy = beforeNode && beforeNode.health !== node.health && ["risk", "blocked"].includes(node.health);
      const reported = Boolean(body.action?.includes("робочий звіт"));
      const recipients = createdBlocker
        ? [createdBlocker.ownerId, createdBlocker.escalationToId]
        : createdDecision
          ? [createdDecision.decisionOwnerId]
          : createdAcceptance
            ? [createdAcceptance.acceptorId]
            : becameUnhealthy || reported
              ? [node.ownerId, node.acceptorId]
              : [];
      if (recipients.length) {
        const detail = createdBlocker ? `\nБлокер: ${createdBlocker.title}` : createdDecision ? `\nПотрібне рішення: ${createdDecision.question}` : becameUnhealthy ? `\nСтан: ${node.health === "blocked" ? "заблоковано" : "є ризик"}` : "";
        await notifyTelegramUsers(recipients.filter((id) => id !== user.id), `${body.action || "Оновлено дані"}\n\n${node.code} · ${node.title}${detail}\n\n${baseUrl(request)}/?view=my`);
      }
    }
  }

  return Response.json({ ...next, currentUser: user, storage, authConfigured: Boolean(runtimeEnv().PORTAL_OWNER_CREDENTIAL || runtimeEnv().GOOGLE_CLIENT_ID) });
}
