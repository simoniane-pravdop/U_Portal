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
  const reportingSource = await readFile(new URL("../app/lib/reporting-links.ts", import.meta.url), "utf8");
  const reportingUrl = `data:text/javascript;base64,${Buffer.from(compile(reportingSource)).toString("base64")}`;
  const hierarchyCode = compile(hierarchySource).replace('from "./forecast-deadline"', `from "${helperUrl}"`).replace('from "./reporting-links"', `from "${reportingUrl}"`);
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

test("shared task extends the additional direction and goal only once", async () => {
  const hierarchySource = await readFile(new URL("../app/lib/hierarchy.ts", import.meta.url), "utf8");
  const reportingSource = await readFile(new URL("../app/lib/reporting-links.ts", import.meta.url), "utf8");
  const reportingUrl = `data:text/javascript;base64,${Buffer.from(compile(reportingSource)).toString("base64")}`;
  const hierarchyCode = compile(hierarchySource).replace('from "./forecast-deadline"', `from "${helperUrl}"`).replace('from "./reporting-links"', `from "${reportingUrl}"`);
  const { recalculateHierarchy } = await import(`data:text/javascript;base64,${Buffer.from(hierarchyCode).toString("base64")}`);
  const node = (id, kind, parentId, progress, extra = {}) => ({ id, kind, parentId, progress, weight: 1, health: "normal", lifecycle: "in_progress", decisionRequired: false, forecastEnd: "", plannedEnd: "", updatedAt: "2026-09-30T00:00:00Z", ...extra });
  const state = { nodes: [
    node("g1", "goal", null, 0), node("d1", "cycle", "g1", 0), node("p1", "subcycle", "d1", 0, { linkedParentIds: ["d2"] }),
    node("g2", "goal", null, 0), node("d2", "cycle", "g2", 0), node("p2", "subcycle", "d2", 0),
    node("t", "task", "p1", 80, { linkedParentIds: ["d2", "p2"], forecastEnd: "2026-10-14", plannedEnd: "2026-10-14" }),
  ], blockers: [], decisions: [] };
  recalculateHierarchy(state);
  for (const id of ["p1", "d1", "g1", "p2", "d2", "g2"]) {
    const item = state.nodes.find((entry) => entry.id === id);
    assert.equal(item.progress, 80, id);
    assert.equal(item.forecastEnd, "2026-10-14", id);
  }
});
