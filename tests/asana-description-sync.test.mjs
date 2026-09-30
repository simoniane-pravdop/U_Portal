import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const noImports = (source) => source.replace(/^import .*;\n/gm, "");
const sources = await Promise.all(["app/lib/asana-links.ts", "app/lib/asana-integration.ts", "app/api/asana/sync/route.ts"].map(async (path) => noImports(await readFile(new URL(`../${path}`, import.meta.url), "utf8"))));
const compiled = ts.transpileModule([
  ...sources,
  `let state, actor, requests;
   export function setup(nextState, nextActor) { state = structuredClone(nextState); actor = nextActor; requests = []; }
   export function sentRequests() { return requests; }
   const loadState = async () => ({ state });
   const currentUser = async () => actor;
   const database = async () => null;
   const mayEdit = (user, initiatorId) => user.role === "admin" || user.id === initiatorId;
   const jsonError = (error, status) => Response.json({ error }, { status });
   const asanaRequest = async (userId, path, init = {}) => {
     requests.push({ userId, path, method: init.method || "GET", data: init.body ? JSON.parse(init.body).data : undefined });
     if (path.includes("/stories?")) return { data: [] };
     return { data: { gid: "456789012", workspace: { gid: "12345678" }, tags: [{ gid: "567890123", name: ASANA_MANAGEMENT_TAG }] } };
   };`,
].join("\n"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const admin = { id: "admin", role: "admin", active: true };
const fixture = (rule = "portal") => ({
  users: [admin],
  nodes: [
    { id: "goal", kind: "goal", parentId: null, code: "S1", title: "Гроші", controlPlace: "", asana: { taskGid: "123456789", taskUrl: "https://app.asana.com/0/12345678/123456789" } },
    { id: "cycle", kind: "cycle", parentId: "goal", code: "P1", title: "Напрям", result: "Результат", acceptanceCriteria: "Критерій", controlPlace: "", assigneeId: "executor", acceptorId: "initiator", participantIds: [], plannedEnd: "2026-10-02", asana: { taskGid: "987654321", taskUrl: "https://app.asana.com/0/12345678/987654321", workspaceGid: "12345678" } },
    { id: "task", kind: "task", parentId: "cycle", code: "P1.1", title: "Дія", result: "Результат", acceptanceCriteria: "Критерій", controlPlace: "", assigneeId: "executor", acceptorId: "initiator", participantIds: [], plannedEnd: "2026-10-02", asana: { taskGid: "456789012", taskUrl: "", rules: { description: rule, dates: "manual", status: "manual" } } },
  ],
});
async function sync(action, state = fixture(), actor = admin) {
  if (action === "create") state.nodes.find((node) => node.id === "task").asana.taskGid = "";
  api.setup(state, actor);
  return api.POST(new Request("https://portal.example/api/asana/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, nodeId: "task", taskGid: "456789012", workspaceGid: "12345678", description: "Паспорт\n\nМІСЦЕ В СТРУКТУРІ\nШлях: старий\n\nОпис: результат <тест>" }) }));
}

test("create and portal-controlled update send rich descriptions with actual ancestor links", async () => {
  for (const action of ["create", "update"]) {
    const response = await sync(action);
    assert.equal(response.status, 200);
    const write = api.sentRequests().find((request) => request.method === (action === "create" ? "POST" : "PUT"));
    assert.match(write.data.html_notes, /<a href="https:\/\/app.asana.com\/0\/12345678\/123456789" data-asana-gid="123456789" data-asana-dynamic="false">Стратегічна ціль: S1 · Гроші<\/a>/);
    assert.match(write.data.html_notes, /Опис: результат &lt;тест&gt;/);
    assert.doesNotMatch(write.data.html_notes, /Шлях: старий/);
    assert.equal("notes" in write.data, false, "Do not send conflicting plain and rich descriptions");
    if (action === "create") { assert.equal(write.data.name, "P1.1 Дія"); assert.match(write.path, /^\/tasks\/987654321\/subtasks\?/); }
  }
});

test("free-plan Asana writes keep the due date but never send start_on", async () => {
  for (const action of ["create", "update"]) {
    const state = fixture();
    state.nodes[2].plannedStart = "2026-09-30";
    state.nodes[2].asana.rules.dates = "portal";
    if (action === "create") state.nodes[2].asana.taskGid = "";
    api.setup(state, admin);
    const response = await api.POST(new Request("https://portal.example/api/asana/sync", { method: "POST", body: JSON.stringify({ action, nodeId: "task", taskGid: "456789012", workspaceGid: "12345678", startOn: "2026-09-30", dueOn: "2026-10-02" }) }));
    assert.equal(response.status, 200);
    const write = api.sentRequests().find((request) => request.method === (action === "create" ? "POST" : "PUT"));
    assert.equal(write.data.due_on, "2026-10-02");
    assert.equal("start_on" in write.data, false);
  }
});

test("manual and Asana-controlled descriptions are not overwritten by a portal update", async () => {
  for (const rule of ["manual", "asana"]) {
    const state = fixture(rule);
    state.nodes[2].asana.rules.dates = "portal";
    assert.equal((await sync("update", state)).status, 200);
    const write = api.sentRequests().find((request) => request.method === "PUT");
    assert.equal("html_notes" in write.data, false);
    assert.equal("notes" in write.data, false);
  }
});

test("read and explicit rename do not replace descriptions or write higher-level tasks", async () => {
  for (const action of ["read", "rename"]) {
    assert.equal((await sync(action)).status, 200);
    for (const request of api.sentRequests()) {
      if (request.method !== "GET") {
        assert.match(request.path, /^\/tasks\/456789012\?/);
        assert.deepEqual(request.data, { name: "P1.1 Дія" });
      }
    }
  }
});

test("unrelated readers cannot trigger description writes", async () => {
  assert.equal((await sync("update", fixture(), { id: "reader", role: "executor", active: true })).status, 403);
  assert.equal(api.sentRequests().length, 0);
});

test("a direction becomes a root Asana task, its project a subtask, and its task a nested subtask", async () => {
  const state = fixture();
  const cycle = state.nodes.find((node) => node.id === "cycle");
  cycle.asana.taskGid = "";
  api.setup(state, admin);
  let response = await api.POST(new Request("https://portal.example/api/asana/sync", { method: "POST", body: JSON.stringify({ action: "create", nodeId: "cycle", workspaceGid: "12345678" }) }));
  assert.equal(response.status, 200);
  assert.match(api.sentRequests().find((request) => request.method === "POST").path, /^\/tasks\?/);

  state.nodes.push({ id: "project", kind: "subcycle", parentId: "cycle", code: "P1.2", title: "Проєкт", result: "Результат", acceptanceCriteria: "Критерій", controlPlace: "", assigneeId: "executor", acceptorId: "initiator", participantIds: [], plannedEnd: "2026-10-02", asana: { taskGid: "", taskUrl: "", rules: { description: "portal", dates: "manual", status: "manual" } } });
  cycle.asana.taskGid = "987654321";
  api.setup(state, admin);
  response = await api.POST(new Request("https://portal.example/api/asana/sync", { method: "POST", body: JSON.stringify({ action: "create", nodeId: "project" }) }));
  assert.equal(response.status, 200);
  assert.match(api.sentRequests().find((request) => request.method === "POST").path, /^\/tasks\/987654321\/subtasks\?/);
  assert.equal((await response.json()).parentGid, "987654321");

  state.nodes.find((node) => node.id === "task").parentId = "project";
  state.nodes.find((node) => node.id === "task").asana.taskGid = "";
  state.nodes.find((node) => node.id === "project").asana.taskGid = "111222333";
  api.setup(state, admin);
  response = await api.POST(new Request("https://portal.example/api/asana/sync", { method: "POST", body: JSON.stringify({ action: "create", nodeId: "task" }) }));
  assert.equal(response.status, 200);
  assert.match(api.sentRequests().find((request) => request.method === "POST").path, /^\/tasks\/111222333\/subtasks\?/);
});

test("creation waits for the direct parent and never silently makes a root task", async () => {
  const state = fixture();
  state.nodes.find((node) => node.id === "cycle").asana.taskGid = "";
  state.nodes.find((node) => node.id === "task").asana.taskGid = "";
  api.setup(state, admin);
  const response = await api.POST(new Request("https://portal.example/api/asana/sync", { method: "POST", body: JSON.stringify({ action: "create", nodeId: "task", workspaceGid: "12345678" }) }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Спочатку створіть або прив’яжіть/);
  assert.equal(api.sentRequests().length, 0);
});

test("moving a linked task under its portal parent requires matching current Asana parent", async () => {
  api.setup(fixture(), admin);
  let response = await api.POST(new Request("https://portal.example/api/asana/sync", { method: "POST", body: JSON.stringify({ action: "move", nodeId: "task", taskGid: "456789012", expectedParentGid: "unexpected" }) }));
  assert.equal(response.status, 409);
  assert.equal(api.sentRequests().some((request) => request.path.includes("/setParent")), false);

  api.setup(fixture(), admin);
  response = await api.POST(new Request("https://portal.example/api/asana/sync", { method: "POST", body: JSON.stringify({ action: "move", nodeId: "task", taskGid: "456789012", expectedParentGid: "" }) }));
  assert.equal(response.status, 200);
  const moved = api.sentRequests().find((request) => request.path.includes("/setParent"));
  assert.equal(moved.method, "POST");
  assert.deepEqual(moved.data, { parent: "987654321" });
  assert.equal((await response.json()).parentGid, "987654321");
});
