import type { WorkNode, WorkUpdate } from "../types";
import { compareNodeCodes } from "./node-order";
import { reportingDescendants } from "./reporting-links";

/** Read-only rollup of all task reports. Reports remain stored on their source tasks. */
export function projectTaskResults(nodes: WorkNode[], projectId: string): { task: WorkNode; report: WorkUpdate }[] {
  const found: { task: WorkNode; report: WorkUpdate }[] = [];
  for (const task of reportingDescendants(nodes, projectId).filter((node) => node.kind === "task")) {
    for (const report of task.updates || []) found.push({ task, report });
  }
  return found.sort((a, b) => b.report.createdAt.localeCompare(a.report.createdAt) || compareNodeCodes(a.task, b.task));
}
