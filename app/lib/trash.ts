import type { PortalState, SessionUser, WorkNode } from "../types";
import { recalculateHierarchy } from "./hierarchy";
import { nodeAuditChanges } from "./node-audit";

export const trashFields = ["deletedAt", "deletedById", "deletedBatchId", "trashPreviousArchived"] as const;
export function mayManageTrash(user: Pick<SessionUser, "id" | "role">, node: WorkNode) {
  return ["owner", "admin", "goal_owner", "cycle_owner"].includes(user.role) || node.acceptorId === user.id;
}
export function branchNodes(nodes: WorkNode[], rootId: string) {
  const ids = new Set([rootId]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const node of nodes) if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
      ids.add(node.id); expanded = true;
    }
  }
  return nodes.filter((node) => ids.has(node.id));
}

export class TrashError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** Pure transition: no physical removal, external task changes, or client-authored audit. */
export function changeTrash(current: PortalState, user: SessionUser, rootId: string, action: "delete" | "restore", at = new Date().toISOString()) {
  const root = current.nodes.find((node) => node.id === rootId);
  if (!root) throw new TrashError("Картку не знайдено", 404);
  if (action === "delete" && root.deletedAt) throw new TrashError("Картка вже в кошику", 409);
  if (action === "restore" && (!root.deletedAt || root.deletedBatchId !== root.id)) throw new TrashError("Відновлюйте всю гілку через її головну картку в кошику");
  const targets = action === "delete"
    ? branchNodes(current.nodes, root.id).filter((node) => !node.deletedAt)
    : current.nodes.filter((node) => node.deletedAt && node.deletedBatchId === root.id);
  if (!targets.every((node) => mayManageTrash(user, node))) throw new TrashError("Недостатньо прав для видалення або відновлення всієї гілки", 403);
  const parent = current.nodes.find((node) => node.id === root.parentId);
  if (action === "restore" && parent?.deletedAt) throw new TrashError("Спочатку відновіть батьківську картку");
  const next: PortalState = structuredClone(current);
  const ids = new Set(targets.map((node) => node.id));
  for (const node of next.nodes) if (ids.has(node.id)) {
    if (action === "delete") {
      node.trashPreviousArchived = node.archived;
      node.archived = true;
      node.deletedAt = at;
      node.deletedById = user.id;
      node.deletedBatchId = root.id;
    } else {
      node.archived = Boolean(node.trashPreviousArchived);
      for (const field of trashFields) delete node[field];
    }
    node.updatedAt = at;
  }
  // Removing a reporting location cannot leave dangling links on live cards.
  if (action === "delete") for (const node of next.nodes) {
    const linked = node.linkedParentIds || [];
    if (linked.some((id) => ids.has(id))) {
      node.linkedParentIds = linked.filter((id) => !ids.has(id));
      node.updatedAt = at;
    }
  }
  recalculateHierarchy(next);
  const changed = next.nodes.filter((node) => JSON.stringify(node) !== JSON.stringify(current.nodes.find((item) => item.id === node.id)));
  next.audit = [...changed.map((node) => ({
    id: crypto.randomUUID(), at, by: user.name, entityId: node.id,
    action: ids.has(node.id) ? `${action === "delete" ? "Перенесено до кошика" : "Відновлено з кошика"} ${node.code}` : `Оновлено зведений стан ${node.code}`,
    changes: nodeAuditChanges(current.nodes.find((item) => item.id === node.id), node, next.users, next.nodes),
  })), ...current.audit].slice(0, 2000);
  next.revision = current.revision + 1;
  return { next, targets, changed };
}

/** Irreversible removal from the portal only; Asana tasks are never changed. */
export function purgeTrash(current: PortalState, user: SessionUser, rootId: string | null, at = new Date().toISOString()) {
  if (!["owner", "admin"].includes(user.role)) throw new TrashError("Остаточно видаляти картки може лише власник або адміністратор", 403);
  const root = rootId ? current.nodes.find((node) => node.id === rootId) : undefined;
  if (rootId && (!root || !root.deletedAt)) throw new TrashError("Оберіть картку в кошику", 404);
  // Include independently removed descendants: no card may keep a missing parent.
  const targets = root ? branchNodes(current.nodes, root.id) : current.nodes.filter((node) => node.deletedAt);
  if (!targets.length) throw new TrashError("Кошик порожній", 409);
  if (targets.some((node) => !node.deletedAt)) throw new TrashError("У гілці є активні картки — спочатку перенесіть їх до кошика", 409);
  const ids = new Set(targets.map((node) => node.id));
  const next: PortalState = structuredClone(current);
  next.nodes = next.nodes.filter((node) => !ids.has(node.id));
  for (const node of next.nodes) {
    const linked = node.linkedParentIds || [];
    if (linked.some((id) => ids.has(id))) {
      node.linkedParentIds = linked.filter((id) => !ids.has(id));
      node.updatedAt = at;
    }
  }
  next.dependencies = next.dependencies.filter((item) => !ids.has(item.predecessorId) && !ids.has(item.successorId));
  const removedBlockerIds = new Set(next.blockers.filter((item) => ids.has(item.nodeId)).map((item) => item.id));
  const removedDecisionIds = new Set(next.decisions.filter((item) => ids.has(item.nodeId)).map((item) => item.id));
  next.blockers = next.blockers.filter((item) => !ids.has(item.nodeId));
  next.decisions = next.decisions.filter((item) => !ids.has(item.nodeId));
  next.acceptances = next.acceptances.filter((item) => !ids.has(item.nodeId));
  next.discussions = next.discussions.filter((item) => !ids.has(item.nodeId));
  next.notifications = next.notifications.filter((item) => !ids.has(item.nodeId));
  next.coordinations = next.coordinations.filter((item) => !ids.has(item.cycleId || "") && !ids.has(item.subcycleId)).map((item) => ({
    ...item,
    taskState: item.taskState.filter((task) => !ids.has(task.nodeId)),
    blockerIds: item.blockerIds.filter((id) => !removedBlockerIds.has(id)),
    decisionIds: item.decisionIds.filter((id) => !removedDecisionIds.has(id)),
  }));
  recalculateHierarchy(next);
  const changed = next.nodes.filter((node) => JSON.stringify(node) !== JSON.stringify(current.nodes.find((item) => item.id === node.id)));
  next.audit = [
    { id: crypto.randomUUID(), at, by: user.name, entityId: "portal", action: root ? `Остаточно видалено ${root.code} та гілку (${targets.length} карток)` : `Очищено кошик (${targets.length} карток)` },
    ...next.audit.filter((item) => !ids.has(item.entityId)),
  ].slice(0, 2000);
  next.revision = current.revision + 1;
  return { next, targets, changed };
}
