import type { WorkNode, WorkUpdate } from "../types";
import { compareNodeCodes } from "./node-order";

/** Read-only rollup of all task reports. Reports remain stored on their source tasks. */
export function projectTaskResults(nodes: WorkNode[], projectId: string): { task: WorkNode; report: WorkUpdate }[] {
  const byParent = new Map<string, WorkNode[]>();
  for (const node of nodes) {
    if (!node.parentId || node.archived) continue;
    byParent.set(node.parentId, [...(byParent.get(node.parentId) || []), node]);
  }
  const found: { task: WorkNode; report: WorkUpdate }[] = [];
  const seen = new Set<string>();
  const visit = (parentId: string) => {
    if (seen.has(parentId)) return;
    seen.add(parentId);
    for (const child of byParent.get(parentId) || []) {
      if (child.kind === "task") {
        for (const report of child.updates || []) found.push({ task: child, report });
      } else visit(child.id);
    }
  };
  visit(projectId);
  return found.sort((a, b) => b.report.createdAt.localeCompare(a.report.createdAt) || compareNodeCodes(a.task, b.task));
}
