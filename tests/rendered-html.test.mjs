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

test("initial state has the two authorized administrators and no test management data", async () => {
  const seed = JSON.parse(await readFile(new URL("../app/data/seed.json", import.meta.url), "utf8"));
  assert.equal(seed.version, 2);
  assert.equal(seed.users.length, 2);
  assert.deepEqual(seed.users.map(({ name, email, role }) => ({ name, email, role })), [
    { name: "Володимир Гурлов", email: "vg@pravdop.com", role: "owner" },
    { name: "Едгар Сімонян", email: "simonian.e@pravdop.com", role: "admin" },
  ]);
  assert.ok(seed.users.every((user) => user.active));
  assert.deepEqual(seed.nodes, []);
  assert.deepEqual(seed.dependencies, []);
  assert.deepEqual(seed.blockers, []);
  assert.deepEqual(seed.decisions, []);
  assert.deepEqual(seed.acceptances, []);
  assert.deepEqual(seed.coordinations, []);
  assert.doesNotMatch(JSON.stringify(seed), /password|Test_/i);
});

test("durable storage and integration bindings are declared", async () => {
  const hosting = JSON.parse(await readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"));
  assert.equal(hosting.d1, "DB");
  assert.equal(hosting.r2, "FILES");
  const envExample = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(envExample, /GOOGLE_CLIENT_ID/);
  assert.match(envExample, /ASANA_CLIENT_ID/);
  assert.match(envExample, /TOKEN_ENCRYPTION_KEY/);
  assert.match(envExample, /TELEGRAM_BOT_TOKEN/);
  assert.match(envExample, /TELEGRAM_WEBHOOK_SECRET/);
  assert.match(envExample, /PORTAL_OWNER_CREDENTIAL/);
  assert.match(envExample, /PORTAL_ADMIN_CREDENTIAL/);
  assert.match(envExample, /PORTAL_PASSWORD_PEPPER/);
  const migration = await readFile(new URL("../db/migrations/0001_management_portal.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE `portal_state`/);
  assert.match(migration, /CREATE TABLE `asana_connections`/);
  const credentialMigration = await readFile(new URL("../db/migrations/0002_portal_credentials.sql", import.meta.url), "utf8");
  assert.match(credentialMigration, /CREATE TABLE `portal_credentials`/);
  assert.match(credentialMigration, /CREATE TABLE `portal_login_attempts`/);
  const telegramMigration = await readFile(new URL("../db/migrations/0003_telegram_integration.sql", import.meta.url), "utf8");
  assert.match(telegramMigration, /CREATE TABLE `telegram_links`/);
  assert.match(telegramMigration, /CREATE TABLE `telegram_link_codes`/);
});

test("management workflow separates structure, work, dashboard, settings, and access", async () => {
  const source = await readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8");
  assert.match(source, /Дерево цілей, циклів і завдань/);
  assert.match(source, /Зберегти стан і подати звіт/);
  assert.match(source, /Результати, стани та управлінська реакція/);
  assert.match(source, /Редактор учасників/);
  assert.match(source, /Створити доступ/);
  assert.match(source, /Новий пароль/);
  assert.match(source, /api\/auth\/password/);
  assert.match(source, /api\/admin\/users/);
  assert.match(source, /Створити задачу в Asana/);
  assert.match(source, /Підключити Telegram/);
  assert.match(source, /recalculateHierarchy/);
  assert.match(source, /tree-row-menu/);
  assert.match(source, /mobile-tree-switch/);
  assert.match(source, /compact-tree/);
  assert.doesNotMatch(source, /Дерево УО|Створити УО|Паспорт УО|Нижчі УО|Тут виконується УО/);
  assert.doesNotMatch(source, /id: "integrations"/);
});

test("password authentication uses slow hashing, rate limiting, and no committed passwords", async () => {
  const server = await readFile(new URL("../app/lib/server.ts", import.meta.url), "utf8");
  const login = await readFile(new URL("../app/api/auth/password/route.ts", import.meta.url), "utf8");
  const users = await readFile(new URL("../app/api/admin/users/route.ts", import.meta.url), "utf8");
  const combined = `${server}\n${login}\n${users}`;
  assert.match(server, /PBKDF2/);
  assert.match(server, /100_000/);
  assert.match(server, /passwordMaterial/);
  assert.match(server, /HMAC/);
  assert.match(server, /platformEmail && isLocal\(request\)/);
  assert.match(login, /MAX_FAILURES = 5/);
  assert.match(login, /portal_login_attempts/);
  assert.match(users, /target\?\.role === "owner"/);
  assert.doesNotMatch(combined, /PORTAL_(OWNER|ADMIN)_PASSWORD\s*=/);
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
