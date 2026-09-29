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
    { id: "task", kind: "task", parentId: "goal", code: "P1", title: "Дія", result: "Результат", acceptanceCriteria: "Критерій", controlPlace: "", assigneeId: "executor", acceptorId: "initiator", participantIds: [], plannedEnd: "2026-10-02", asana: { taskGid: "456789012", taskUrl: "", rules: { description: rule, dates: "manual", status: "manual" } } },
  ],
});
async function sync(action, state = fixture(), actor = admin) {
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
    if (action === "create") assert.equal(write.data.name, "P1 Дія");
  }
});

test("manual and Asana-controlled descriptions are not overwritten by a portal update", async () => {
  for (const rule of ["manual", "asana"]) {
    const state = fixture(rule);
    state.nodes[1].asana.rules.dates = "portal";
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
        assert.deepEqual(request.data, { name: "P1 Дія" });
      }
    }
  }
});

test("unrelated readers cannot trigger description writes", async () => {
  assert.equal((await sync("update", fixture(), { id: "reader", role: "executor", active: true })).status, 403);
  assert.equal(api.sentRequests().length, 0);
});
