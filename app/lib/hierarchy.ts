import type { PortalState, WorkNode } from "../types";

export function recalculateHierarchy(state: PortalState) {
  const active = state.nodes.filter((node) => !node.archived);
  const depth = (node: WorkNode) => {
    let value = 0;
    let current = node;
    const visited = new Set([node.id]);
    while (current.parentId && !visited.has(current.parentId)) {
      value += 1;
      const parent = state.nodes.find((item) => item.id === current.parentId);
      if (!parent) break;
      visited.add(parent.id);
      current = parent;
    }
    return value;
  };
  const parents = active.filter((node) => node.kind !== "task").sort((a, b) => depth(b) - depth(a));
  for (const parent of parents) {
    const children = active.filter((node) => node.parentId === parent.id);
    const before = JSON.stringify({ progress: parent.progress, health: parent.health, decisionRequired: parent.decisionRequired, lifecycle: parent.lifecycle, forecastEnd: parent.forecastEnd });
    const calculatedHealth = state.blockers.some((item) => item.nodeId === parent.id && item.status === "open") ? "blocked" : "normal";
    parent.health = parent.healthOverride || calculatedHealth;
    parent.decisionRequired = state.decisions.some((item) => item.nodeId === parent.id && item.status === "requested");
    if (!children.length) {
      const after = JSON.stringify({ progress: parent.progress, health: parent.health, decisionRequired: parent.decisionRequired, lifecycle: parent.lifecycle, forecastEnd: parent.forecastEnd });
      if (before !== after) parent.updatedAt = new Date().toISOString();
      continue;
    }
    const totalWeight = children.reduce((sum, child) => sum + Math.max(1, child.weight || 1), 0);
    parent.progress = Math.round(children.reduce((sum, child) => sum + child.progress * Math.max(1, child.weight || 1), 0) / totalWeight);
    const meaningful = children.filter((child) => child.lifecycle !== "cancelled");
    if (parent.lifecycleOverride) parent.lifecycle = parent.lifecycleOverride;
    else if (meaningful.length && meaningful.every((child) => child.lifecycle === "completed")) parent.lifecycle = "completed";
    else if (meaningful.some((child) => ["in_progress", "acceptance", "completed"].includes(child.lifecycle))) parent.lifecycle = "in_progress";
    else if (meaningful.length && meaningful.every((child) => child.lifecycle === "idea")) parent.lifecycle = "idea";
    else if (meaningful.length && meaningful.every((child) => child.lifecycle === "ready")) parent.lifecycle = "ready";
    else if (meaningful.length && meaningful.every((child) => child.lifecycle === "paused")) parent.lifecycle = "paused";
    else parent.lifecycle = "planned";
    const forecasts = children.map((child) => child.forecastEnd || child.plannedEnd).filter(Boolean).sort();
    if (forecasts.length) parent.forecastEnd = forecasts.at(-1) || parent.forecastEnd;
    const after = JSON.stringify({ progress: parent.progress, health: parent.health, decisionRequired: parent.decisionRequired, lifecycle: parent.lifecycle, forecastEnd: parent.forecastEnd });
    if (before !== after) parent.updatedAt = new Date().toISOString();
  }
}
