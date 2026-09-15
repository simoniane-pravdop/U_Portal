import type { PortalState, SessionUser } from "../types";
import { recalculateHierarchy } from "./hierarchy";

export function isDerivedHierarchyChange(current: PortalState, next: PortalState, id: string) {
  const before = current.nodes.find((node) => node.id === id);
  const after = next.nodes.find((node) => node.id === id);
  if (!before || !after || before.kind === "task") return false;
  const expected = structuredClone(next);
  expected.nodes = expected.nodes.map((node) => node.id === id ? structuredClone(before) : node);
  recalculateHierarchy(expected);
  const calculated = expected.nodes.find((node) => node.id === id)!;
  // The clock can differ across client and server; every other field must match.
  calculated.updatedAt = after.updatedAt;
  return JSON.stringify(calculated) === JSON.stringify(after);
}

/** Re-route only pending work; completed decisions and legacy ownership stay intact. */
export function routePendingRequests(state: PortalState, notify = false, now = new Date().toISOString()) {
  const nodes = new Map(state.nodes.map((node) => [node.id, node]));
  const route = (item: { id: string; nodeId: string }, previous: string, type: "blocker" | "decision" | "acceptance") => {
    const node = nodes.get(item.nodeId);
    if (!node?.acceptorId || node.acceptorId === previous) return previous;
    for (const message of state.discussions || []) {
      if (message.relatedType === type && message.relatedId === item.id && !message.resolvedAt) message.recipientId = node.acceptorId;
    }
    if (notify && !node.archived) {
      const id = `initiator:${type}:${item.id}:${node.acceptorId}`;
      state.notifications ||= [];
      if (!state.notifications.some((entry) => entry.id === id)) state.notifications.unshift({
        id, userId: node.acceptorId, actorId: "system", nodeId: node.id, type,
        title: `Потрібне ${type === "blocker" ? "погодження блокера" : type === "decision" ? "рішення" : "приймання результату"} · ${node.code}`,
        detail: `Ви — ініціатор картки «${node.title}». Запит очікує вашої відповіді.`, createdAt: now, readAt: "",
      });
    }
    return node.acceptorId;
  };
  for (const item of state.blockers) if (item.status === "open" && (!item.approvalStatus || item.approvalStatus === "pending")) item.escalationToId = route(item, item.escalationToId, "blocker");
  for (const item of state.decisions) if (item.status === "requested") item.decisionOwnerId = route(item, item.decisionOwnerId, "decision");
  for (const item of state.acceptances) if (item.status === "submitted") item.acceptorId = route(item, item.acceptorId, "acceptance");
}

/** Approval authority is independent of permission to edit or execute a card. */
export function approvalChangeError(current: PortalState, next: PortalState, user: SessionUser): string | null {
  const canApprove = (nodeId: string) => ["owner", "admin"].includes(user.role)
    || current.nodes.find((node) => node.id === nodeId)?.acceptorId === user.id;
  for (const item of next.acceptances) {
    const before = current.acceptances.find((entry) => entry.id === item.id);
    if ((!before && item.status !== "submitted" || before && ["status", "feedback", "decidedAt"].some((key) => before[key as keyof typeof before] !== item[key as keyof typeof item])) && !canApprove(item.nodeId)) return "Прийняти або повернути результат може лише ініціатор картки.";
  }
  for (const item of next.decisions) {
    const before = current.decisions.find((entry) => entry.id === item.id);
    if ((!before && item.status !== "requested" || before && ["status", "resolution", "decidedAt"].some((key) => before[key as keyof typeof before] !== item[key as keyof typeof item])) && !canApprove(item.nodeId)) return "Прийняти рішення може лише ініціатор картки.";
  }
  for (const item of next.blockers) {
    const before = current.blockers.find((entry) => entry.id === item.id);
    if ((!before && item.approvalStatus && item.approvalStatus !== "pending" || before && ["approvalStatus", "approvalComment", "approvedBy", "approvedAt"].some((key) => before[key as keyof typeof before] !== item[key as keyof typeof item])) && !canApprove(item.nodeId)) return "Погодити або відхилити блокер може лише ініціатор картки.";
  }
  return null;
}
