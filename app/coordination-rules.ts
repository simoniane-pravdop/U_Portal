import type { WorkNode } from "./types";

type CoordinationNode = Pick<WorkNode, "kind" | "lifecycle" | "archived">;

// Match the portal's active-state filter: ideas and closed work are inactive.
export function missingActiveTasksReason(node: CoordinationNode, branch: CoordinationNode[]): string | null {
  if (node.archived || !["cycle", "subcycle"].includes(node.kind)
    || ["idea", "completed", "cancelled"].includes(node.lifecycle)) return null;

  const hasActiveTask = branch.some((item) => item.kind === "task" && !item.archived
    && !["idea", "completed", "cancelled"].includes(item.lifecycle));
  if (hasActiveTask) return null;

  return node.kind === "cycle" ? "Напрям зусиль без активних завдань" : "Проект без активних завдань";
}
