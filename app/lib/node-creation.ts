import type { AuditEntry, PortalUser, WorkNode } from "../types";

/** Never identify the current assignee/initiator as the creator of an older card. */
export function nodeCreation(node: WorkNode, audit: AuditEntry[], users: PortalUser[]) {
  const creationEvent = audit
    .filter((entry) => entry.entityId === node.id && entry.action.startsWith("Створено "))
    .sort((left, right) => left.at.localeCompare(right.at))[0];
  if (node.createdById) {
    return {
      name: users.find((user) => user.id === node.createdById)?.name || creationEvent?.by || "Невідомий користувач",
      at: node.createdAt,
    };
  }
  // Older cards did not store a creator ID. The server audit is the only reliable attribution.
  return { name: creationEvent?.by || "Не зафіксовано", at: creationEvent?.at || "" };
}
