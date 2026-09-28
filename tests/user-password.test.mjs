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
  const runtimeModule = { exports: {} };
  new Function("require", "module", "exports", outputText)((id) => dependencies[id] || require(id), runtimeModule, runtimeModule.exports);
  return runtimeModule.exports;
}
const passwords = await load("../app/lib/user-password.ts");

test("generated passwords are strong, varied and never stored in the contact draft", async () => {
  const values = new Set();
  for (let index = 0; index < 100; index++) {
    const value = passwords.generatePassword();
    assert.equal(value.length, 20);
    for (const pattern of [/[A-Z]/, /[a-z]/, /[0-9]/, /[!@#$%_+-]/]) assert.match(value, pattern);
    values.add(value);
  }
  assert.equal(values.size, 100);
  const source = await readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8");
  assert.match(source, /JSON.stringify\(\{ name: newUser.name, email: newUser.email, role: newUser.role \}\)/);
  assert.match(source, /onClick=\{\(\) => openPassword\(user\)\}/);
  assert.match(source, /Зберегти новий пароль/);
  assert.match(source, /committed\?\.\(\);[\s\S]*await reload\(\)/);
  assert.match(source, /Не вдалося скопіювати автоматично/);
});

test("only owner/admin may reset non-owner accounts, including peer admins", () => {
  const roles = ["owner", "admin", "executor", "coordinator", "viewer", "goal_owner", "cycle_owner"];
  for (const actor of roles) for (const target of roles) {
    assert.equal(passwords.mayResetPassword({ role: actor }, { role: target }), ["owner", "admin"].includes(actor) && target !== "owner");
  }
});

async function fixture(actorRole = "admin", conflict = false) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE portal_state(id TEXT PRIMARY KEY, payload TEXT, revision INTEGER, updated_at TEXT, updated_by TEXT); CREATE TABLE portal_credentials(user_id TEXT PRIMARY KEY, email TEXT, password_hash TEXT, password_salt TEXT, password_iterations INTEGER, must_change_password INTEGER, created_at TEXT, updated_at TEXT, created_by TEXT); CREATE TABLE portal_sessions(user_id TEXT);");
  const state = { version: 2, revision: 1, users: [{ id: "actor", name: "Test actor", email: "actor@example.test", role: actorRole, active: true }, { id: "target", name: "Test admin", email: "target@example.test", role: "admin", active: true }, { id: "owner", name: "Test owner", email: "owner@example.test", role: "owner", active: true }], notifications: [], audit: [] };
  sqlite.prepare("INSERT INTO portal_state VALUES ('main', ?, 1, '', '')").run(JSON.stringify(state));
  sqlite.exec("INSERT INTO portal_credentials VALUES ('target','target@example.test','old-hash','salt',1,0,'','',''); INSERT INTO portal_sessions VALUES ('target');");
  const db = {
    prepare(sql) { return { bind(...args) { return { sql, args }; } }; },
    async batch(statements) {
      if (conflict) sqlite.prepare("UPDATE portal_state SET revision = 2, payload = ?").run(JSON.stringify({ ...state, revision: 2, audit: [{ id: "other-operation" }] }));
      sqlite.exec("BEGIN");
      try {
        const results = statements.map(({ sql, args }) => ({ meta: { changes: sqlite.prepare(sql).run(...args).changes } }));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  const route = await load("../app/api/admin/users/route.ts", {
    "../../../lib/user-password": passwords,
    "../../../lib/server": {
      currentUser: async () => state.users[0], loadState: async () => ({ state, storage: "database" }), database: async () => db,
      runtimeEnv: () => ({ PORTAL_PASSWORD_PEPPER: "synthetic-test-only" }),
      jsonError: (error, status) => Response.json({ error }, { status }),
      validatePassword: (value) => value.length < 12 ? "Invalid test password" : "",
      hashPassword: async () => ({ passwordHash: "new-hash", passwordSalt: "new-salt", passwordIterations: 100 }),
    },
  });
  const post = (body) => route.POST(new Request("http://localhost/api/admin/users", { method: "POST", body: JSON.stringify(body) }));
  return { sqlite, post };
}

test("reset applies only after explicit POST, returns no password and invalidates target sessions", async () => {
  const { sqlite, post } = await fixture();
  try {
    assert.equal(sqlite.prepare("SELECT password_hash FROM portal_credentials").get().password_hash, "old-hash");
    const password = passwords.generatePassword();
    const response = await post({ action: "reset_password", userId: "target", password });
    assert.equal(response.status, 200);
    assert.equal(sqlite.prepare("SELECT password_hash FROM portal_credentials").get().password_hash, "new-hash");
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM portal_sessions").get().n, 0);
    assert.equal(JSON.stringify(await response.json()).includes(password), false);
    assert.equal(sqlite.prepare("SELECT payload FROM portal_state").get().payload.includes(password), false);
  } finally { sqlite.close(); }
});

test("reset permission does not grant peer-admin role editing or changes to owner credentials", async () => {
  const { sqlite, post } = await fixture();
  try {
    assert.equal((await post({ action: "update", userId: "target", name: "Changed" })).status, 403);
    assert.equal((await post({ action: "reset_password", userId: "owner", password: passwords.generatePassword() })).status, 403);
    assert.equal((await post({ action: "reset_password", userId: "target", password: "short" })).status, 400);
    assert.equal(sqlite.prepare("SELECT password_hash FROM portal_credentials").get().password_hash, "old-hash");
  } finally { sqlite.close(); }
});

test("ordinary users cannot reset passwords", async () => {
  const { sqlite, post } = await fixture("executor");
  try { assert.equal((await post({ action: "reset_password", userId: "target", password: passwords.generatePassword() })).status, 403); }
  finally { sqlite.close(); }
});

test("a conflicting reset never silently changes credentials or deletes sessions", async () => {
  const { sqlite, post } = await fixture("admin", true);
  try {
    assert.equal((await post({ action: "reset_password", userId: "target", password: passwords.generatePassword() })).status, 409);
    assert.equal(sqlite.prepare("SELECT password_hash FROM portal_credentials").get().password_hash, "old-hash");
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM portal_sessions").get().n, 1);
  } finally { sqlite.close(); }
});

test("owner may create another admin with the chosen generated password", async () => {
  const { sqlite, post } = await fixture("owner");
  try {
    assert.equal((await post({ action: "create", name: "New admin", email: "new@example.test", role: "admin", password: passwords.generatePassword() })).status, 200);
    assert.equal(sqlite.prepare("SELECT password_hash FROM portal_credentials WHERE email='new@example.test'").get().password_hash, "new-hash");
  } finally { sqlite.close(); }
});
