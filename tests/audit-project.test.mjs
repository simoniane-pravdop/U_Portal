import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function load(relativePath, modules = {}) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const runtimeModule = { exports: {} };
  new Function("require", "module", "exports", output)((id) => modules[id], runtimeModule, runtimeModule.exports);
  return runtimeModule.exports;
}

test("server audit records the exact before and after values, but not metadata churn", async () => {
  const { nodeAuditChanges } = await load("../app/lib/node-audit.ts");
  const before = { id: "project", title: "Старий проєкт", description: "Початковий опис", assigneeId: "u1", lifecycle: "draft", updatedAt: "old" };
  const after = { ...before, title: "Новий проєкт", assigneeId: "u2", lifecycle: "in_progress", updatedAt: "new" };
  const changes = nodeAuditChanges(before, after, [{ id: "u1", name: "Перший" }, { id: "u2", name: "Другий" }]);
  assert.deepEqual(changes.map(({ field, from, to }) => [field, from, to]), [
    ["title", "Старий проєкт", "Новий проєкт"],
    ["assigneeId", "Перший", "Другий"],
    ["lifecycle", "Чернетка", "У роботі"],
  ]);
  const route = await readFile(new URL("../app/api/state/route.ts", import.meta.url), "utf8");
  assert.match(route, /changes: before \? nodeAuditChanges\(before, after, next\.users/);
  assert.match(route, /next\.audit = \[/);
});

test("project results aggregate all reports of descendant active tasks", async () => {
  const order = await load("../app/lib/node-order.ts");
  const reporting = await load("../app/lib/reporting-links.ts");
  const { projectTaskResults } = await load("../app/lib/project-results.ts", { "./node-order": order, "./reporting-links": reporting });
  const report = (createdAt, summary) => ({ createdAt, summary });
  const nodes = [
    { id: "p", kind: "subcycle", parentId: "c" },
    { id: "group", kind: "subcycle", parentId: "p" },
    { id: "t2", code: "P1.2", kind: "task", parentId: "p", updates: [report("2026-09-01", "Старе"), report("2026-09-10", "Нове")] },
    { id: "t1", code: "P1.1", kind: "task", parentId: "group", updates: [report("2026-09-02", "Готово")] },
    { id: "t3", code: "P1.3", kind: "task", parentId: "p", updates: [] },
    { id: "t4", code: "P1.4", kind: "task", parentId: "p", archived: true, updates: [report("2026-09-03", "Архів")] },
    { id: "other", code: "P2.1", kind: "task", parentId: "other-project", updates: [report("2026-09-04", "Чуже")] },
  ];
  assert.deepEqual(projectTaskResults(nodes, "p").map(({ task, report }) => [task.code, report.summary]), [["P1.2", "Нове"], ["P1.1", "Готово"], ["P1.2", "Старе"]]);
});

test("one task reports into additional projects and directions without duplicating a report", async () => {
  const order = await load("../app/lib/node-order.ts");
  const reporting = await load("../app/lib/reporting-links.ts");
  const { projectTaskResults } = await load("../app/lib/project-results.ts", { "./node-order": order, "./reporting-links": reporting });
  const nodes = [
    { id: "g1", code: "S1", kind: "goal", parentId: null },
    { id: "d1", code: "P1", kind: "cycle", parentId: "g1" },
    { id: "p1", code: "P1.1", kind: "subcycle", parentId: "d1" },
    { id: "g2", code: "S2", kind: "goal", parentId: null },
    { id: "d2", code: "P2", kind: "cycle", parentId: "g2" },
    { id: "p2", code: "P2.1", kind: "subcycle", parentId: "d2" },
    { id: "t", code: "P1.1.1", kind: "task", parentId: "p1", linkedParentIds: ["p2", "d2"], updates: [{ id: "r", createdAt: "2026-09-30", summary: "Один результат" }] },
  ];
  assert.deepEqual(reporting.reportingDescendants(nodes, "d2").filter((node) => node.kind === "task").map((node) => node.code), ["P1.1.1"]);
  assert.deepEqual(projectTaskResults(nodes, "p2").map(({ report }) => report.id), ["r"]);
  assert.deepEqual(projectTaskResults(nodes, "d2").map(({ report }) => report.id), ["r"]);
  assert.deepEqual(projectTaskResults(nodes, "g2").map(({ report }) => report.id), ["r"]);
  assert.equal(reporting.reportingLinkError(nodes, nodes.at(-1)), null);
  assert.match(reporting.reportingLinkError(nodes, { ...nodes.at(-1), linkedParentIds: ["p1"] }), /Основна гілка/);
  assert.match(reporting.reportingLinkError(nodes, { ...nodes.at(-1), linkedParentIds: ["p2", "p2"] }), /двічі/);
});

test("one project reports its task results into several directions with one stable code", async () => {
  const order = await load("../app/lib/node-order.ts");
  const reporting = await load("../app/lib/reporting-links.ts");
  const { projectTaskResults } = await load("../app/lib/project-results.ts", { "./node-order": order, "./reporting-links": reporting });
  const nodes = [
    { id: "g1", code: "S1", kind: "goal", parentId: null },
    { id: "d1", code: "P1", kind: "cycle", parentId: "g1" },
    { id: "g2", code: "S2", kind: "goal", parentId: null },
    { id: "d2", code: "P2", kind: "cycle", parentId: "g2" },
    { id: "p", code: "P1.1", kind: "subcycle", parentId: "d1", linkedParentIds: ["d2"] },
    { id: "t", code: "P1.1.1", kind: "task", parentId: "p", linkedParentIds: ["d2"], updates: [{ id: "r", createdAt: "2026-09-30", summary: "Спільний результат" }] },
  ];
  assert.equal(nodes[4].code, "P1.1");
  assert.equal(reporting.reportingLinkError(nodes, nodes[4]), null);
  assert.deepEqual(reporting.reportingChildren(nodes, "d2").map((node) => node.id), ["p", "t"]);
  assert.deepEqual(projectTaskResults(nodes, "d2").map(({ report }) => report.id), ["r"]);
  assert.deepEqual(projectTaskResults(nodes, "g2").map(({ report }) => report.id), ["r"]);
  assert.match(reporting.reportingLinkError(nodes, { ...nodes[4], linkedParentIds: ["d1"] }), /Основна гілка/);
  assert.match(reporting.reportingLinkError(nodes, { ...nodes[4], linkedParentIds: ["p"] }), /чинний напрям/);
});

test("duplicating a card copies its passport but never reports or Asana binding", async () => {
  const { duplicateNodeDraft } = await load("../app/lib/duplicate-node.ts");
  const blank = { id: "new", parentId: "d1", code: "P1.2", kind: "subcycle", title: "", description: "", result: "", participantIds: [], lifecycle: "draft", progress: 0, evidence: [], updates: [], linkedParentIds: [], asana: { taskGid: "" }, createdAt: "new-time", updatedAt: "new-time", recurrence: { enabled: false, nextDate: "" } };
  const source = { ...blank, id: "old", code: "P1.1", title: "Оригінал", description: "Опис", result: "Готово", participantIds: ["u1"], lifecycle: "completed", progress: 100, linkedParentIds: ["d2"], evidence: [{ id: "e" }], updates: [{ id: "r" }], asana: { taskGid: "123" }, createdAt: "old-time" };
  const copy = duplicateNodeDraft(source, blank);
  assert.deepEqual([copy.id, copy.code, copy.title, copy.description, copy.result], ["new", "P1.2", "Оригінал (копія)", "Опис", "Готово"]);
  assert.deepEqual([copy.lifecycle, copy.progress, copy.linkedParentIds, copy.updates, copy.evidence, copy.asana.taskGid], ["draft", 0, [], [], [], ""]);
  source.participantIds.push("u2");
  assert.deepEqual(copy.participantIds, ["u1"]);
});

test("coordination info and project result sections remain visible in their respective cards", async () => {
  const source = await readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8");
  assert.match(source, /className="coordination-info-toggle"/);
  assert.match(source, /"Що є результатом"/);
  assert.match(source, /"Що не є результатом"/);
  assert.match(source, /"Критерії прийняття"/);
  assert.match(source, /selected\.kind !== "task" && <ProjectTaskResults/);
  assert.match(source, /current\.kind !== "task" && <ProjectTaskResults/);
  assert.match(source, /<NodeAuditHistory node=\{current\} audit=\{payload\.audit\} \/>/);
});
