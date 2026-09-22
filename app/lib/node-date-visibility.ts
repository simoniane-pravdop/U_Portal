import type { NodeKind } from "../types";

// Direction and project milestones stay in the audit data, but their cards focus on outcomes.
export function showActualMilestones(kind: NodeKind) {
  return kind === "goal" || kind === "task";
}
