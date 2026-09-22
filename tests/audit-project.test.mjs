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
  const { projectTaskResults } = await load("../app/lib/project-results.ts", { "./node-order": order });
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

test("coordination info and project result sections remain visible in their respective cards", async () => {
  const source = await readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8");
  assert.match(source, /className="coordination-info-toggle"/);
  assert.match(source, /"Що є результатом"/);
  assert.match(source, /"Що не є результатом"/);
  assert.match(source, /"Критерії прийняття"/);
  assert.match(source, /selected\.kind === "subcycle" && <ProjectTaskResults/);
  assert.match(source, /current\.kind === "subcycle" && <ProjectTaskResults/);
  assert.match(source, /<NodeAuditHistory node=\{current\} audit=\{payload\.audit\} \/>/);
});
