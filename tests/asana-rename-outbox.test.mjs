import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = (await readFile(new URL("../app/lib/asana-outbox.ts", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "");
const harness = `
let state, rows, titles, requests, failure;
const database = async () => ({
  prepare(sql) {
    return { bind(...params) {
      return {
        async all() { return { results: rows.filter((row) => row.author_id === params[0] && row.status === "pending" && (!sql.includes("AND node_id = ?") || row.node_id === params[1])).slice(0, 3) }; },
        async first() { return { count: rows.filter((row) => row.author_id === params[0] && row.status === "pending").length }; },
        async run() {
          if (sql.startsWith("INSERT INTO asana_task_titles")) titles.set(params[0], params[1]);
          else if (sql.startsWith("UPDATE portal_state")) {
            if (state.revision !== params[5]) return { meta: { changes: 0 } };
            state = JSON.parse(params[0]);
            return { meta: { changes: 1 } };
          } else if (sql.startsWith("UPDATE asana_outbox")) {
            const row = rows.find((candidate) => candidate.event_id === params.at(-1));
            row.status = sql.includes("status = 'sent'") ? "sent" : sql.includes("status = 'cancelled'") ? "cancelled" : row.status;
            if (sql.includes("last_error = ?")) row.last_error = params[0];
          }
          return { meta: { changes: 1 } };
        },
      };
    } };
  },
});
const loadState = async () => ({ state: JSON.parse(JSON.stringify(state)) });
const primaryAsanaTitle = (node) => (node.code + " " + node.title).trim();
const asanaRequest = async (userId, path, init = {}) => {
  requests.push({ userId, path, method: init.method, data: JSON.parse(init.body).data });
  if (failure) throw new Error(failure);
  return { data: { name: JSON.parse(init.body).data.name } };
};
const portalMessageForAsana = () => "";
const portalOriginId = () => "";
const portalReportForAsana = () => "";
const baseUrl = () => "";
const portalHref = () => "";
export function setup(config = {}) {
  state = { revision: 1, nodes: [{ id: "node", code: "P1.1", title: "Нова назва", asana: { taskGid: config.taskGid || "123456789", remoteName: "Стара назва" } }], users: [] };
  rows = [{ event_id: "rename-1", node_id: "node", task_gid: "123456789", author_id: "user", recipient_id: "", kind: "rename", payload: JSON.stringify({ name: config.requestedName || "P1.1 Нова назва" }), status: "pending" }];
  titles = new Map(); requests = []; failure = config.failure || "";
}
export function snapshot() { return { state, rows, titles, requests }; }
`;
const compiled = ts.transpileModule(harness + source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const outbox = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const request = new Request("https://portal.example/api/state");

test("saving a renamed portal card updates only its linked primary Asana task", async () => {
  outbox.setup();
  const result = await outbox.flushAsanaOutbox(request, "user", "node");
  const { state, rows, titles, requests } = outbox.snapshot();
  assert.deepEqual(result, { sent: 1, pending: 0, errors: [] });
  assert.deepEqual(requests, [{ userId: "user", path: "/tasks/123456789?opt_fields=gid,name", method: "PUT", data: { name: "P1.1 Нова назва" } }]);
  assert.equal(rows[0].status, "sent");
  assert.equal(state.nodes[0].asana.remoteName, "P1.1 Нова назва");
  assert.equal(state.revision, 2);
  assert.equal(titles.get("123456789"), "P1.1 Нова назва");
});

test("stale or detached rename events never overwrite an Asana title", async () => {
  for (const config of [{ requestedName: "P1.1 Застаріла назва" }, { taskGid: "987654321" }]) {
    outbox.setup(config);
    const result = await outbox.flushAsanaOutbox(request, "user", "node");
    assert.equal(result.sent, 0);
    assert.equal(outbox.snapshot().rows[0].status, "cancelled");
    assert.deepEqual(outbox.snapshot().requests, []);
  }
});

test("Asana errors leave a rename pending for explicit retry", async () => {
  outbox.setup({ failure: "Підключіть особистий Asana-акаунт" });
  const result = await outbox.flushAsanaOutbox(request, "user", "node");
  assert.equal(result.pending, 1);
  assert.match(result.errors[0], /Підключіть особистий/);
  assert.equal(outbox.snapshot().rows[0].status, "pending");
});
