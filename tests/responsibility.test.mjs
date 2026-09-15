import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
function declarations(source, names) {
  const parsed = ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return parsed.statements.filter((item) => ts.isFunctionDeclaration(item) && names.includes(item.name?.text)).map((item) => item.getText(parsed)).join("\n");
}
const noImports = (source) => source.replace(/^import .*;\n/gm, "");
const server = await read("app/lib/server.ts");
const ui = await read("app/PortalApp.tsx");
const source = [
  noImports(await read("app/lib/hierarchy.ts")),
  noImports(await read("app/lib/responsibility.ts")),
  declarations(server, ["mayEdit", "jsonError"]),
  declarations(ui, ["workFilterForUser", "hasWorkAccessForUser"]),
  noImports(await read("app/api/state/route.ts")),
  `let state, actor, persisted;
   export function setup(value, user) { state = structuredClone(value); actor = user; persisted = undefined; }
   export function savedState() { return persisted; }
   const loadState = async () => ({ state, storage: "memory" });
   const currentUser = async () => actor;
   const database = async () => ({
     prepare(sql) { return { bind(...args) { return { sql, args, first: async () => null }; } }; },
     async batch(statements) { for (const item of statements) if (item.sql.startsWith("UPDATE portal_state")) persisted = JSON.parse(item.args[0]); return statements.map(() => ({ meta: { changes: 1 } })); }
   });
   const runtimeEnv = () => ({});
   const notifyTelegramUsers = async () => {};
   const baseUrl = () => "http://localhost";
   export { visibleNodeIds, stateForUser, workFilterForUser, hasWorkAccessForUser };`,
].join("\n");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const rules = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const user = (id, role = "executor") => ({ id, role, name: id, email: `${id}@example.test`, active: true });
const initiator = user("initiator");
const executor = user("executor");
const coordinator = user("coordinator", "coordinator");
const legacy = user("legacy");
const makeNode = (id = "task", extra = {}) => ({ id, code: id, title: id, kind: "task", parentId: null, ownerId: legacy.id, acceptorId: initiator.id, assigneeId: executor.id, participantIds: [], visibility: "participants", lifecycle: "in_progress", health: "normal", decisionRequired: false, progress: 0, weight: 1, plannedEnd: "", forecastEnd: "", updatedAt: "2026-09-01T00:00:00Z", ...extra });
const seed = JSON.parse(await read("app/data/seed.json"));
function fixture() {
  return { ...structuredClone(seed), version: 3, users: [initiator, executor, coordinator, legacy, user("admin", "admin")], nodes: [makeNode()], notifications: [], discussions: [], audit: [], settings: { ...seed.settings, telegramPlanned: false } };
}
async function post(state, actor, edit, action = "Зміна картки") {
  rules.setup(state, actor);
  const submitted = rules.stateForUser(structuredClone(state), actor);
  edit(submitted);
  return rules.POST(new Request("http://localhost/api/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: submitted, expectedRevision: state.revision, action, entityId: "task" }) }));
}

test("coordinator sees every private and archived card, but legacy card coordinator grants no access", () => {
  const state = fixture();
  state.nodes.push(makeNode("archive", { archived: true }), makeNode("other", { acceptorId: "other", assigneeId: "other" }));
  assert.deepEqual([...rules.visibleNodeIds(state, coordinator)], ["task", "archive", "other"]);
  assert.deepEqual([...rules.visibleNodeIds(state, legacy)], []);
  assert.equal(rules.mayEdit(coordinator, initiator.id), false);
  assert.equal(rules.mayEdit(coordinator, coordinator.id), true);
  assert.equal(rules.workFilterForUser(state.nodes[0], initiator), "acceptance");
  assert.equal(rules.workFilterForUser(state.nodes[0], executor), "action");
  assert.equal(rules.hasWorkAccessForUser(state.nodes[0], legacy), false);
});

test("server rejects coordinator writes, locks out self-assigned approvals and allows own notification reads", async () => {
  const state = fixture();
  for (const edit of [
    (next) => { next.nodes[0].title = "Changed"; },
    (next) => { next.nodes.push(makeNode("new", { acceptorId: coordinator.id })); },
    (next) => { next.discussions.push({ id: "comment", nodeId: "task", authorId: coordinator.id, recipientId: coordinator.id, text: "x" }); },
    (next) => { next.decisions.push({ id: "decision", nodeId: "task", decisionOwnerId: coordinator.id, status: "requested" }); },
    (next) => { next.blockers.push({ id: "blocker", nodeId: "task", ownerId: coordinator.id, escalationToId: coordinator.id, status: "open", approvalStatus: "pending" }); },
  ]) assert.equal((await post(state, coordinator, edit)).status, 403);
  state.notifications.push({ id: "notice", userId: coordinator.id, nodeId: "task", readAt: "" });
  assert.equal((await post(state, coordinator, (next) => { next.notifications[0].readAt = "2026-09-15T12:00:00Z"; }, "Сповіщення прочитано")).status, 200);
});

test("only initiator or administrator approves blockers, decisions and completion", async () => {
  const state = fixture();
  state.acceptances = [{ id: "acceptance", nodeId: "task", submittedBy: executor.id, acceptorId: initiator.id, status: "submitted", feedback: "", decidedAt: "" }];
  state.decisions = [{ id: "decision", nodeId: "task", decisionOwnerId: initiator.id, status: "requested", resolution: "", decidedAt: "" }];
  state.blockers = [{ id: "blocker", nodeId: "task", ownerId: executor.id, escalationToId: initiator.id, status: "open", approvalStatus: "pending", approvalComment: "", approvedBy: "", approvedAt: "" }];
  for (const edit of [
    (next) => { next.acceptances[0].status = "accepted"; next.acceptances[0].feedback = "Прийнято"; },
    (next) => { next.decisions[0].status = "decided"; next.decisions[0].resolution = "Варіант А"; },
    (next) => { next.blockers[0].approvalStatus = "approved"; next.blockers[0].approvalComment = "Підтверджую"; },
  ]) {
    assert.equal((await post(state, executor, edit)).status, 403);
    assert.equal((await post(state, coordinator, edit)).status, 403);
    assert.equal((await post(state, initiator, edit)).status, 200);
    assert.equal((await post(state, user("admin", "admin"), edit)).status, 200);
  }
  assert.equal((await post(state, executor, (next) => { next.nodes[0].acceptorId = executor.id; })).status, 403);
});

test("new requests and completion notifications go to initiator, not former coordinator", async () => {
  const state = fixture();
  const response = await post(state, executor, (next) => {
    next.nodes[0].lifecycle = "acceptance";
    next.acceptances.push({ id: "new", nodeId: "task", submittedBy: executor.id, acceptorId: legacy.id, status: "submitted" });
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.acceptances[0].acceptorId, initiator.id);
  assert.deepEqual(rules.savedState().notifications.map((item) => item.userId), [initiator.id]);
  const pending = fixture();
  pending.decisions = [{ id: "d", nodeId: "task", status: "requested", decisionOwnerId: legacy.id }];
  pending.blockers = [{ id: "b", nodeId: "task", status: "open", approvalStatus: "pending", escalationToId: legacy.id }];
  rules.routePendingRequests(pending, true, "2026-09-15T12:00:00Z");
  assert.ok(pending.notifications.every((item) => item.userId === initiator.id));
  assert.equal(pending.decisions[0].decisionOwnerId, initiator.id);
  assert.equal(pending.blockers[0].escalationToId, initiator.id);
});

test("pending-request migration is idempotent and preserves cards, history and completed responses", () => {
  const state = fixture();
  state.decisions = [{ id: "pending", nodeId: "task", status: "requested", decisionOwnerId: legacy.id }, { id: "done", nodeId: "task", status: "decided", decisionOwnerId: legacy.id, resolution: "Історичне рішення" }];
  state.discussions = [{ id: "message", nodeId: "task", relatedType: "decision", relatedId: "pending", recipientId: legacy.id, text: "Оригінальне питання" }];
  const before = structuredClone(state);
  rules.routePendingRequests(state, true, "2026-09-15T12:00:00Z");
  assert.deepEqual(state.nodes, before.nodes);
  assert.deepEqual(state.audit, before.audit);
  assert.deepEqual(state.decisions[1], before.decisions[1]);
  assert.equal(state.discussions[0].recipientId, initiator.id);
  assert.equal(state.discussions[0].text, "Оригінальне питання");
  const migrated = structuredClone(state);
  rules.routePendingRequests(state, true);
  assert.deepEqual(state, migrated);
});

test("card forms and descriptions use initiator and executor without a coordinator field", () => {
  assert.match(ui, /Field label="Ініціатор"/);
  assert.match(ui, /Field label="Виконавець"/);
  assert.doesNotMatch(ui, /Field label="Координатор"|<span>Координатор<\/span>|<dt>Координатор<\/dt>|Керівник[ау]? вищої ланки|Координую/);
  assert.match(ui, /coordinator: "Координатор"/);
  assert.match(ui, /escalationToId: node.acceptorId, status: "open"/);
  assert.match(ui, /decisionOwnerId: node.acceptorId, resolution:/);
});

test("executor can update own work with automatic parent rollup but cannot edit parent's passport", async () => {
  const state = fixture();
  state.nodes = [makeNode("parent", { kind: "cycle", assigneeId: "other", acceptorId: "other" }), makeNode("task", { parentId: "parent" })];
  for (const actor of [executor, { ...coordinator, id: executor.id }]) {
    const response = await post(state, actor, (next) => { next.nodes.find((node) => node.id === "task").progress = 50; rules.recalculateHierarchy(next); });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).nodes.find((node) => node.id === "parent").progress, 50);
    const denied = await post(state, actor, (next) => { next.nodes.find((node) => node.id === "parent").title = "Forged"; });
    assert.equal(denied.status, 403);
  }
});
