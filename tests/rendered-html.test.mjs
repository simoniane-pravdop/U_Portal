import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the management portal shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<html lang="uk">/i);
  assert.match(html, /Управлінський портал/i);
  assert.match(html, /Правова Допомога/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("pilot data has a valid hierarchy and management controls", async () => {
  const seed = JSON.parse(await readFile(new URL("../app/data/seed.json", import.meta.url), "utf8"));
  const ids = new Set(seed.nodes.map((node) => node.id));
  const codes = seed.nodes.map((node) => node.code);
  const userIds = new Set(seed.users.map((user) => user.id));
  assert.equal(ids.size, seed.nodes.length);
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(seed.nodes.some((node) => node.code === "S1"));
  assert.ok(seed.nodes.some((node) => node.code === "P1.1" && node.kind === "subcycle"));
  assert.ok(seed.nodes.some((node) => node.code === "P1.1.4" && node.startMode === "manual_capacity"));
  for (const node of seed.nodes) {
    if (node.parentId) assert.ok(ids.has(node.parentId), `Unknown parent for ${node.code}`);
    assert.ok(userIds.has(node.ownerId), `Unknown owner for ${node.code}`);
    assert.ok(userIds.has(node.assigneeId), `Unknown assignee for ${node.code}`);
    assert.ok(userIds.has(node.acceptorId), `Unknown acceptor for ${node.code}`);
    assert.equal("intermediateResult" in node, false);
    assert.ok(node.asana?.rules?.title);
  }
  for (const dependency of seed.dependencies) {
    assert.ok(ids.has(dependency.predecessorId));
    assert.ok(ids.has(dependency.successorId));
    assert.notEqual(dependency.predecessorId, dependency.successorId);
  }
  for (const blocker of seed.blockers) {
    assert.ok(ids.has(blocker.nodeId));
    assert.ok(blocker.escalationToId);
    assert.ok(blocker.decisionDue);
  }
});

test("durable storage and integration bindings are declared", async () => {
  const hosting = JSON.parse(await readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"));
  assert.equal(hosting.d1, "DB");
  assert.equal(hosting.r2, "FILES");
  const envExample = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(envExample, /GOOGLE_CLIENT_ID/);
  assert.match(envExample, /ASANA_CLIENT_ID/);
  assert.match(envExample, /TOKEN_ENCRYPTION_KEY/);
  const migration = await readFile(new URL("../db/migrations/0001_management_portal.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE `portal_state`/);
  assert.match(migration, /CREATE TABLE `asana_connections`/);
});

test("management unit workflow separates structure, work, dashboard, and settings", async () => {
  const source = await readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8");
  assert.match(source, /Дерево управлінських одиниць/);
  assert.match(source, /Зберегти стан і подати звіт/);
  assert.match(source, /Результати, стани та управлінська реакція/);
  assert.match(source, /Редактор учасників/);
  assert.match(source, /Створити задачу в Asana/);
  assert.match(source, /recalculateHierarchy/);
  assert.match(source, /tree-row-menu/);
  assert.match(source, /mobile-tree-switch/);
  assert.match(source, /compact-tree/);
  assert.doesNotMatch(source, /id: "integrations"/);
});

test("compact laptop and mobile layouts are declared", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 1250px\)/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(max-width: 520px\)/);
  assert.match(css, /\.tree-workbench\.compact-tree/);
  assert.match(css, /\.tree-workbench\.mobile-pane-tree \.node-detail/);
  assert.match(css, /position: fixed; z-index: 90; top: auto; right: 0; bottom: 0/);
});
