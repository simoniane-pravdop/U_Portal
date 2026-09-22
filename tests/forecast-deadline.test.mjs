import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const compile = (source) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const source = await readFile(new URL("../app/lib/forecast-deadline.ts", import.meta.url), "utf8");
const helperUrl = `data:text/javascript;base64,${Buffer.from(compile(source)).toString("base64")}`;
const { plannedEndForForecast } = await import(helperUrl);

test("a later forecast extends the card deadline without shortening it later", () => {
  assert.equal(plannedEndForForecast("2026-09-30", "2026-10-14"), "2026-10-14");
  assert.equal(plannedEndForForecast("2026-10-14", "2026-10-01"), "2026-10-14");
  assert.equal(plannedEndForForecast("2026-09-30", "2026-09-30"), "2026-09-30");
  assert.equal(plannedEndForForecast("2026-09-30", ""), "2026-09-30");
  assert.equal(plannedEndForForecast("", "2026-10-14"), "2026-10-14");
});

test("a new descendant forecast extends the deadlines of its project, direction and goal", async () => {
  const hierarchySource = await readFile(new URL("../app/lib/hierarchy.ts", import.meta.url), "utf8");
  const hierarchyCode = compile(hierarchySource).replace('from "./forecast-deadline"', `from "${helperUrl}"`);
  const { recalculateHierarchy } = await import(`data:text/javascript;base64,${Buffer.from(hierarchyCode).toString("base64")}`);
  const node = (id, kind, parentId, forecastEnd, plannedEnd) => ({
    id, kind, parentId, progress: 0, weight: 1, health: "normal", lifecycle: "in_progress",
    decisionRequired: false, forecastEnd, plannedEnd, updatedAt: "2026-09-22T00:00:00Z",
  });
  const state = {
    nodes: [
      node("goal", "goal", null, "2026-09-30", "2026-09-30"),
      node("cycle", "cycle", "goal", "2026-09-30", "2026-09-30"),
      node("project", "subcycle", "cycle", "2026-09-30", "2026-09-30"),
      node("task", "task", "project", "2026-10-14", "2026-10-14"),
    ],
    blockers: [], decisions: [],
  };
  recalculateHierarchy(state);
  for (const parent of state.nodes.slice(0, 3)) {
    assert.equal(parent.forecastEnd, "2026-10-14");
    assert.equal(parent.plannedEnd, "2026-10-14");
  }
});
