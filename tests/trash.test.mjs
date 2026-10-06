import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
async function load(path, dependencies = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const mod = { exports: {} };
  new Function("require", "module", "exports", outputText)((id) => dependencies[id] || require(id), mod, mod.exports);
  return mod.exports;
}
const forecast = await load("../app/lib/forecast-deadline.ts");
const reporting = await load("../app/lib/reporting-links.ts");
const hierarchy = await load("../app/lib/hierarchy.ts", { "./forecast-deadline": forecast, "./reporting-links": reporting });
const audit = await load("../app/lib/node-audit.ts");
const trash = await load("../app/lib/trash.ts", { "./hierarchy": hierarchy, "./node-audit": audit });
const seed = JSON.parse(await readFile(new URL("../app/data/seed.json", import.meta.url), "utf8"));
const actor = { id: "admin", name: "Test admin", email: "admin@example.test", role: "admin", active: true };
const node = (id, parentId = null, extra = {}) => ({
  id, parentId, code: id, kind: parentId ? "task" : "cycle", title: id, archived: false,
  assigneeId: "executor", acceptorId: "initiator", participantIds: [], lifecycle: "in_progress", health: "normal", decisionRequired: false, progress: 50, weight: 1,
  forecastEnd: "", plannedEnd: "", evidence: [{ id: "proof", value: "https://example.test/proof" }],
  updates: [{ id: "report", note: "Preserve report" }], asana: { taskGid: "123", taskUrl: "https://app.asana.com/0/0/123" }, ...extra,
});
function state() {
  return { ...structuredClone(seed), revision: 1, users: [actor], nodes: [node("P1"), node("P1.1", "P1", { kind: "subcycle" }), node("P1.1.1", "P1.1"), node("P2")],
    dependencies: [{ id: "dep", predecessorId: "P1.1.1", successorId: "P2" }], discussions: [{ id: "message", nodeId: "P1.1.1", text: "Keep comment" }],
    blockers: [{ id: "blocker", nodeId: "P1.1.1", status: "open" }], decisions: [], acceptances: [], coordinations: [], notifications: [], audit: [] };
}
test("trash keeps an entire branch, reports, links, comments and relations; restore preserves the archive state", () => {
  const before = state();
  before.nodes[2].archived = true;
  const removed = trash.changeTrash(before, actor, "P1", "delete", "2026-09-28T10:00:00Z");
  assert.equal(removed.targets.length, 3);
  assert.equal(removed.next.nodes.length, before.nodes.length);
  assert.equal(before.nodes[0].deletedAt, undefined);
  for (const item of removed.next.nodes.slice(0, 3)) assert.equal(item.deletedBatchId, "P1");
  assert.equal(removed.next.nodes[3].deletedAt, undefined);
  const restored = trash.changeTrash(removed.next, actor, "P1", "restore").next;
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(restored.nodes[i].updates, before.nodes[i].updates);
    assert.deepEqual(restored.nodes[i].asana, before.nodes[i].asana);
    assert.deepEqual(restored.nodes[i].evidence, before.nodes[i].evidence);
    assert.equal(restored.nodes[i].archived, before.nodes[i].archived);
    assert.equal(restored.nodes[i].deletedAt, undefined);
  }
  for (const key of ["dependencies", "discussions", "blockers"]) assert.deepEqual(restored[key], before[key]);
  assert.match(removed.next.audit[0].action, /Перенесено до кошика/);
  assert.match(restored.audit[0].action, /Відновлено з кошика/);
});
test("independently removed descendants remain removed until their own branch is restored", () => {
  const childRemoved = trash.changeTrash(state(), actor, "P1.1.1", "delete").next;
  const parentRemoved = trash.changeTrash(childRemoved, actor, "P1", "delete").next;
  assert.throws(() => trash.changeTrash(parentRemoved, actor, "P1.1.1", "restore"), /батьківську/);
  const parentRestored = trash.changeTrash(parentRemoved, actor, "P1", "restore").next;
  assert.ok(parentRestored.nodes[2].deletedAt);
  assert.equal(trash.changeTrash(parentRestored, actor, "P1.1.1", "restore").next.nodes[2].deletedAt, undefined);
  assert.throws(() => trash.changeTrash(trash.changeTrash(state(), actor, "P1", "delete").next, actor, "P1.1", "restore"), /головну/);
});
test("only managers or each card's initiator may remove a branch", () => {
  const before = state();
  for (const role of ["executor", "coordinator", "viewer"]) assert.throws(() => trash.changeTrash(before, { ...actor, id: "executor", role }, "P1", "delete"), /прав/);
  const initiator = { ...actor, id: "initiator", role: "executor" };
  assert.equal(trash.changeTrash(before, initiator, "P1", "delete").targets.length, 3);
  before.nodes[2].acceptorId = "someone-else";
  assert.throws(() => trash.changeTrash(before, initiator, "P1", "delete"), /прав/);
  assert.throws(() => trash.changeTrash(before, actor, "missing", "delete"), /не знайдено/);
});
test("permanent deletion removes a deleted branch, its records, and independently deleted descendants", () => {
  const childRemoved = trash.changeTrash(state(), actor, "P1.1.1", "delete").next;
  const removed = trash.changeTrash(childRemoved, actor, "P1", "delete").next;
  removed.nodes[3].linkedParentIds = ["P1.1"];
  removed.notifications.push({ id: "notice", nodeId: "P1.1.1" });
  removed.coordinations.push({ id: "coord", subcycleId: "P1.1", taskState: [{ nodeId: "P1.1.1" }], blockerIds: ["blocker"], decisionIds: [] });
  const purged = trash.purgeTrash(removed, actor, "P1", "2026-09-28T11:00:00Z");
  assert.equal(purged.targets.length, 3);
  assert.deepEqual(purged.next.nodes.map((item) => item.id), ["P2"]);
  for (const key of ["dependencies", "discussions", "blockers", "notifications", "coordinations"]) assert.deepEqual(purged.next[key], []);
  assert.deepEqual(purged.next.nodes[0].linkedParentIds, []);
  assert.match(purged.next.audit[0].action, /Остаточно видалено/);
  assert.throws(() => trash.purgeTrash(removed, { ...actor, role: "coordinator" }, "P1"), /адміністратор/);
  assert.throws(() => trash.purgeTrash(state(), actor, "P1"), /кошик/);
});
test("emptying the trash leaves active cards and never removes their own records", () => {
  const removed = trash.changeTrash(state(), actor, "P1.1.1", "delete").next;
  removed.coordinations.push({ id: "coord", subcycleId: "P1.1", taskState: [{ nodeId: "P1.1.1" }], blockerIds: ["blocker"], decisionIds: [] });
  const purged = trash.purgeTrash(removed, actor, null);
  assert.deepEqual(purged.next.nodes.map((item) => item.id), ["P1", "P1.1", "P2"]);
  assert.deepEqual(purged.next.coordinations[0].taskState, []);
  assert.deepEqual(purged.next.coordinations[0].blockerIds, []);
});
test("an individual card inside a removed branch can be purged without deleting its parent or siblings", () => {
  const removed = trash.changeTrash(state(), actor, "P1", "delete").next;
  const purged = trash.purgeTrash(removed, actor, "P1.1.1");
  assert.deepEqual(purged.next.nodes.map((item) => item.id), ["P1", "P1.1", "P2"]);
  assert.ok(purged.next.nodes[0].deletedAt);
  assert.ok(purged.next.nodes[1].deletedAt);
});

async function fixture({ conflict = false, locked = false, unauthenticated = false } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE portal_state (id TEXT PRIMARY KEY, payload TEXT, revision INTEGER, updated_at TEXT, updated_by TEXT); CREATE TABLE portal_edit_locks(entity_id TEXT, user_id TEXT, user_name TEXT, expires_at TEXT); CREATE TABLE portal_entity_versions(id TEXT, entity_id TEXT, revision INTEGER, user_id TEXT, user_name TEXT, action TEXT, payload TEXT, created_at TEXT); CREATE TABLE asana_outbox (node_id TEXT); CREATE TABLE sync_events (node_id TEXT);");
  sqlite.prepare("INSERT INTO portal_state VALUES ('main', ?, 1, '', '')").run(JSON.stringify(state()));
  if (locked) sqlite.exec("INSERT INTO portal_edit_locks VALUES ('P1.1.1','other','Other editor','2099-01-01');");
  const db = {
    prepare(sql) { return { bind(...args) { return { sql, args, first: async () => sqlite.prepare(sql).get(...args) }; } }; },
    async batch(statements) {
      if (conflict) sqlite.exec("UPDATE portal_state SET revision = 2");
      sqlite.exec("BEGIN");
      try { const results = statements.map(({ sql, args }) => ({ meta: { changes: sqlite.prepare(sql).run(...args).changes } })); sqlite.exec("COMMIT"); return results; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  const route = await load("../app/api/trash/route.ts", { "../../lib/trash": trash, "../../lib/server": {
    loadState: async () => ({ state: JSON.parse(sqlite.prepare("SELECT payload FROM portal_state").get().payload) }),
    currentUser: async () => unauthenticated ? null : actor, database: async () => db,
    jsonError: (error, status) => Response.json({ error }, { status }),
  } });
  return { sqlite, post: (body) => route.POST(new Request("http://localhost/api/trash", { method: "POST", body: JSON.stringify(body) })) };
}
test("authenticated deletion and restoration persist atomically with server-side versions", async () => {
  const { sqlite, post } = await fixture();
  try {
    assert.equal((await post({ action: "delete", nodeId: "P1", expectedRevision: 1 })).status, 200);
    const saved = JSON.parse(sqlite.prepare("SELECT payload FROM portal_state").get().payload);
    assert.equal(saved.revision, 2);
    assert.ok(saved.nodes[0].deletedAt);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM portal_entity_versions").get().n, 3);
    assert.equal((await post({ action: "restore", nodeId: "P1", expectedRevision: 2 })).status, 200);
    assert.equal(JSON.parse(sqlite.prepare("SELECT payload FROM portal_state").get().payload).nodes[0].deletedAt, undefined);
  } finally { sqlite.close(); }
});
test("stale versions, concurrent saves, active editors and anonymous requests cannot delete data", async () => {
  for (const [options, revision, status] of [[{}, 0, 409], [{ conflict: true }, 1, 409], [{ locked: true }, 1, 423], [{ unauthenticated: true }, 1, 401]]) {
    const { sqlite, post } = await fixture(options);
    try {
      assert.equal((await post({ action: "delete", nodeId: "P1", expectedRevision: revision })).status, status);
      assert.equal(JSON.parse(sqlite.prepare("SELECT payload FROM portal_state").get().payload).nodes[0].deletedAt, undefined);
      assert.equal(sqlite.prepare("SELECT count(*) AS n FROM portal_entity_versions").get().n, 0);
    } finally { sqlite.close(); }
  }
});
test("permanent deletion requires confirmation and removes server-side versions and pending sync records", async () => {
  const { sqlite, post } = await fixture();
  try {
    assert.equal((await post({ action: "delete", nodeId: "P1.1.1", expectedRevision: 1 })).status, 200);
    sqlite.prepare("INSERT INTO asana_outbox VALUES (?)").run("P1.1.1");
    sqlite.prepare("INSERT INTO sync_events VALUES (?)").run("P1.1.1");
    assert.equal((await post({ action: "purge", nodeId: "P1.1.1", expectedRevision: 2 })).status, 400);
    assert.equal((await post({ action: "purge", nodeId: "P1.1.1", confirmation: "P1.1.1", expectedRevision: 2 })).status, 200);
    const saved = JSON.parse(sqlite.prepare("SELECT payload FROM portal_state").get().payload);
    assert.equal(saved.nodes.some((item) => item.id === "P1.1.1"), false);
    assert.equal(saved.dependencies.length, 0);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM portal_entity_versions WHERE entity_id = 'P1.1.1'").get().n, 0);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM asana_outbox").get().n, 0);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sync_events").get().n, 0);
    assert.equal((await post({ action: "empty", confirmation: "ВИДАЛИТИ ВСЕ", expectedRevision: 3 })).status, 409);
  } finally { sqlite.close(); }
});
test("emptying requires its exact phrase and respects revisions", async () => {
  const { sqlite, post } = await fixture();
  try {
    await post({ action: "delete", nodeId: "P1.1.1", expectedRevision: 1 });
    assert.equal((await post({ action: "empty", confirmation: "remove", expectedRevision: 2 })).status, 400);
    assert.equal((await post({ action: "empty", confirmation: "ВИДАЛИТИ ВСЕ", expectedRevision: 1 })).status, 409);
    assert.equal((await post({ action: "empty", confirmation: "ВИДАЛИТИ ВСЕ", expectedRevision: 2 })).status, 200);
    assert.equal(JSON.parse(sqlite.prepare("SELECT payload FROM portal_state").get().payload).nodes.length, 3);
  } finally { sqlite.close(); }
});
test("action menu uses a body-level layer above sticky navigation and both entry points provide deletion", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const ui = await readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8");
  const menu = await readFile(new URL("../app/components/CardActionsMenu.tsx", import.meta.url), "utf8");
  assert.match(css, /\.work-card-actions-popover\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*200/);
  assert.match(menu, /createPortal\([\s\S]*document\.body\)/);
  assert.match(ui, /<CardActionsMenu key=\{current.id\}>/);
  assert.match(ui, /trashAction\(current, "delete"\)/);
  assert.match(ui, /trashAction\(node, "delete"\)/);
  assert.match(ui, /<TrashPanel payload=/);
  assert.match(ui, /nodes=\{\[\.\.\.payload.nodes, \.\.\.\(payload.trashNodes/);
});
