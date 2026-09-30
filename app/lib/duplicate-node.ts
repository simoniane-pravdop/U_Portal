import type { WorkNode } from "../types";

/** Copy the passport, not the execution history or external task binding. */
export function duplicateNodeDraft(source: WorkNode, blank: WorkNode): WorkNode {
  return {
    ...blank,
    title: `${source.title} (копія)`,
    description: source.description,
    result: source.result,
    nonResult: source.nonResult,
    acceptanceCriteria: source.acceptanceCriteria,
    assigneeId: source.assigneeId,
    acceptorId: source.acceptorId,
    participantIds: [...source.participantIds],
    priority: source.priority,
    weight: source.weight,
    startMode: source.startMode,
    resource: source.resource,
    authority: source.authority,
    coordinationCadence: source.coordinationCadence,
    coordinationIntervalDays: source.coordinationIntervalDays,
    coordinationWeekday: source.coordinationWeekday,
    visibility: source.visibility,
    recurrence: { ...source.recurrence, nextDate: "" },
    linkedParentIds: [],
  };
}
