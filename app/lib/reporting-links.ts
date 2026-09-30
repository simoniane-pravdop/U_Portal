import type { WorkNode } from "../types";

/** A link is a second view of a task or project, never a copy or a new code. */
export function reportingChildren(nodes: WorkNode[], parentId: string): WorkNode[] {
  return nodes.filter((node) => !node.archived && !node.deletedAt
    && (node.parentId === parentId || ["task", "subcycle"].includes(node.kind) && (node.linkedParentIds || []).includes(parentId)));
}

/** Traverse both the primary tree and reporting links, counting each card only once. */
export function reportingDescendants(nodes: WorkNode[], rootId: string): WorkNode[] {
  const byId = new Map(nodes.filter((node) => !node.archived && !node.deletedAt).map((node) => [node.id, node]));
  const result: WorkNode[] = [];
  const seen = new Set<string>();
  const pending = [rootId];
  while (pending.length) {
    const id = pending.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    result.push(node);
    for (const child of reportingChildren(nodes, id)) pending.push(child.id);
  }
  return result;
}

export function reportingLinkError(nodes: WorkNode[], unit: WorkNode, previous?: WorkNode): string | null {
  if (!["task", "subcycle"].includes(unit.kind)) return unit.linkedParentIds?.length ? "Додаткові зв’язки доступні лише для завдань і проектів." : null;
  const ids = unit.linkedParentIds || [];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) return "Некоректні додаткові зв’язки завдання.";
  if (new Set(ids).size !== ids.length) return "Один напрям або проект не можна додати двічі.";
  const ancestors = new Set<string>();
  let parentId = unit.parentId;
  while (parentId && !ancestors.has(parentId)) {
    ancestors.add(parentId);
    parentId = nodes.find((node) => node.id === parentId)?.parentId || null;
  }
  for (const id of ids) {
    const target = nodes.find((node) => node.id === id);
    const validKind = unit.kind === "subcycle" ? target?.kind === "cycle" : target && ["cycle", "subcycle"].includes(target.kind);
    if (!target || target.deletedAt || !validKind || target.archived && !(previous?.linkedParentIds || []).includes(id)) return "Оберіть чинний напрям зусиль або проект для додаткового зв’язку.";
    if (ancestors.has(id)) return "Основна гілка вже містить це завдання; додатковий зв’язок тут не потрібен.";
  }
  return null;
}
