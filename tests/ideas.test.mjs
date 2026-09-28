import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

const migration = await readFile(new URL("../db/migrations/0006_portal_ideas.sql", import.meta.url), "utf8");
const source = await readFile(new URL("../app/api/ideas/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const author = { id: "author", name: "Автор", role: "executor", active: true };
function fixture(user = author, conflict = false) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  const db = { prepare(sql) {
    let args = [];
    const statement = {
      bind(...values) { args = values; return statement; },
      first: async () => sqlite.prepare(sql).get(...args) || null,
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
      run: async () => {
        if (conflict && sql.startsWith("UPDATE portal_ideas")) sqlite.exec("UPDATE portal_ideas SET version = version + 1");
        return { meta: { changes: sqlite.prepare(sql).run(...args).changes } };
      },
    };
    return statement;
  } };
  const mod = { exports: {} };
  const server = { baseUrl: () => "https://portal.example", loadState: async () => ({ state: { revision: 238, nodes: [] } }), currentUser: async () => user, database: async () => db, jsonError: (error, status) => Response.json({ error }, { status }) };
  new Function("require", "module", "exports", compiled)((id) => { assert.equal(id, "../../lib/server"); return server; }, mod, mod.exports);
  return {
    sqlite,
    get: () => mod.exports.GET(new Request("https://portal.example/api/ideas")),
    post: (body, origin = "https://portal.example") => mod.exports.POST(new Request("http://127.0.0.1:3000/api/ideas", { method: "POST", headers: { Origin: origin }, body: JSON.stringify(body) })),
  };
}
test("ideas persist title and description independently; edits retain their author and creation date", async () => {
  const f = fixture();
  try {
    const response = await f.post({ title: "  Ідея  ", description: " Опис\nДругий рядок " });
    assert.equal(response.status, 201);
    const { idea } = await response.json();
    assert.equal(idea.title, "Ідея");
    assert.equal(idea.description, "Опис\nДругий рядок");
    assert.equal(idea.createdById, author.id);
    assert.equal(idea.version, 1);
    const updated = await f.post({ id: idea.id, version: 1, title: "Оновлена ідея", description: "" });
    assert.equal(updated.status, 200);
    const saved = (await updated.json()).idea;
    assert.equal(saved.version, 2);
    assert.equal(saved.createdAt, idea.createdAt);
    assert.equal(saved.createdById, author.id);
    assert.equal((await (await f.get()).json()).ideas[0].title, "Оновлена ідея");
    assert.equal(sqliteTables(f.sqlite).includes("portal_state"), false);
  } finally { f.sqlite.close(); }
});
function sqliteTables(db) { return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name); }
test("ideas require authentication, valid text and same-origin writes", async () => {
  const anonymous = fixture(null);
  const f = fixture();
  try {
    assert.equal((await anonymous.get()).status, 401);
    assert.equal((await anonymous.post({ title: "Idea", description: "" })).status, 401);
    for (const body of [null, {}, { title: " ", description: "" }, { title: 1, description: "" }, { title: "x".repeat(251), description: "" }, { title: "Idea", description: "x".repeat(12001) }, { id: 7, title: "Idea", description: "" }]) assert.equal((await f.post(body)).status, 400);
    assert.equal((await f.post({ title: "Idea", description: "" }, "https://other.example")).status, 403);
    assert.equal((await (await f.get()).json()).ideas.length, 0);
  } finally { anonymous.sqlite.close(); f.sqlite.close(); }
});
test("all authenticated roles may record ideas, but only the author or admin may edit", async () => {
  for (const role of ["executor", "coordinator", "viewer", "goal_owner", "cycle_owner", "admin", "owner"]) {
    const f = fixture({ ...author, role });
    try {
      assert.equal((await f.post({ title: role, description: "" })).status, 201);
      f.sqlite.prepare("INSERT INTO portal_ideas VALUES ('other', 'Other idea', '', 'other-user', '2026-01-01', '2026-01-01', 1)").run();
      assert.equal((await f.get()).status, 200);
      const response = await f.post({ id: "other", version: 1, title: "Changed", description: "" });
      assert.equal(response.status, ["owner", "admin"].includes(role) ? 200 : 403);
    } finally { f.sqlite.close(); }
  }
});
test("stale forms and simultaneous edits cannot silently overwrite an idea", async () => {
  for (const conflict of [false, true]) {
    const f = fixture(author, conflict);
    try {
      const { idea } = await (await f.post({ title: "Original", description: "Keep" })).json();
      assert.equal((await f.post({ id: idea.id, version: conflict ? 1 : 0, title: "Overwrite", description: "" })).status, 409);
      assert.equal(f.sqlite.prepare("SELECT title FROM portal_ideas").get().title, "Original");
    } finally { f.sqlite.close(); }
  }
});
test("ideas appear after coordination and open the existing hierarchy form with both texts", async () => {
  const ui = await readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8");
  const component = await readFile(new URL("../app/components/IdeasView.tsx", import.meta.url), "utf8");
  assert.match(ui, /id: "coordination"[\s\S]*id: "ideas"[\s\S]*id: "settings"/);
  assert.match(ui, /\["calendar", "coordination", "ideas", "settings"\]/);
  assert.match(ui, /view === "ideas"[\s\S]*title: idea.title, description: idea.description[\s\S]*setModal\("node"\)/);
  assert.match(component, /localStorage.setItem\(draftKey/);
  assert.match(component, /canCreateNode && <button/);
  assert.match(component, /createNode\(idea\)/);
});
