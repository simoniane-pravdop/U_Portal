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
  const logo = await readFile(new URL("../public/pravdop-logo.png", import.meta.url));
  assert.ok(logo.length > 100);
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
  assert.deepEqual(seed.discussions, []);
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
  const collaborationMigration = await readFile(new URL("../db/migrations/0004_collaboration.sql", import.meta.url), "utf8");
  assert.match(collaborationMigration, /CREATE TABLE `portal_edit_locks`/);
  assert.match(collaborationMigration, /CREATE TABLE `portal_entity_versions`/);
  const asanaSync = await readFile(new URL("../app/api/asana/sync/route.ts", import.meta.url), "utf8");
  assert.match(asanaSync, /addFollowers/);
  assert.match(asanaSync, /followers\.gid/);
  const asanaSearch = await readFile(new URL("../app/api/asana/tasks/search/route.ts", import.meta.url), "utf8");
  assert.match(asanaSearch, /резервний|fallbackParams/);
  assert.match(asanaSearch, /completed_since/);
  const asanaDisconnect = await readFile(new URL("../app/api/asana/disconnect/route.ts", import.meta.url), "utf8");
  assert.match(asanaDisconnect, /oauth_revoke/);
  assert.match(asanaDisconnect, /DELETE FROM asana_connections/);
  const stateRoute = await readFile(new URL("../app/api/state/route.ts", import.meta.url), "utf8");
  assert.match(stateRoute, /next\.notifications\.unshift/);
  assert.match(stateRoute, /startsWith\("Сповіщення"\)/);
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
  assert.match(source, /Створити в Asana й прив’язати/);
  assert.match(source, /Мої завдання ·/);
  assert.match(source, /без проєкту/);
  assert.match(source, /workspaceGid/);
  assert.match(source, /Перевірити й прив’язати/);
  assert.match(source, /Знайти завдання за назвою/);
  assert.match(source, /asana-search-results/);
  assert.match(source, /api\/asana\/tasks\/search/);
  assert.match(source, /Asana автоматично додається до «Контрольного місця»/);
  assert.match(source, /Є ризик виконання/);
  assert.match(source, /completionBlockReason/);
  assert.match(source, /window\.history\.pushState/);
  assert.match(source, /popstate/);
  assert.match(source, /Копіювати посилання/);
  assert.match(source, /pravdop-logo\.png/);
  assert.match(source, /sidebarCollapsed/);
  assert.match(source, /Розгорнути бічне меню/);
  assert.match(source, /Підключити Telegram/);
  assert.match(source, /recalculateHierarchy/);
  assert.match(source, /tree-row-menu/);
  assert.match(source, /mobile-tree-switch/);
  assert.match(source, /compact-tree/);
  assert.match(source, /tree-width-handle/);
  assert.match(source, /portal:tree-navigation-width/);
  assert.match(source, /flatLevelResults \? directMatches/);
  assert.match(source, /tree-filter-path/);
  assert.match(source, /Шлях до \$\{node\.code\}/);
  assert.match(source, /kindLabels\[ancestor\.kind\].*ancestor\.title/);
  assert.match(source, /return \["cycle", "subcycle"\]/);
  assert.match(source, /Додати завдання/);
  assert.match(source, /Завдання можна включити безпосередньо в управлінський цикл або в його підцикл/);
  assert.match(source, /portal:node-draft/);
  assert.match(source, /Дані автоматично оновлено/);
  assert.match(source, /Питання, рішення, погодження та коментарі/);
  assert.match(source, /Вхідні та сповіщення/);
  assert.match(source, /Повернути з коментарем/);
  assert.match(source, /Зафіксувати інше рішення/);
  assert.match(source, /Прийняте рішення/);
  assert.match(source, /Прийняття рішення/);
  assert.match(source, /Учасники \/ фоловери/);
  assert.match(source, /Завершено в Asana/);
  assert.match(source, /Перепідключити акаунт/);
  assert.match(source, /Відключити акаунт/);
  assert.match(source, /Шлях координації/);
  assert.match(source, /Координація циклу \$\{node\.code\}: \$\{node\.title\}/);
  assert.match(source, /Рівень управління/);
  assert.match(source, /Усі цілі/);
  assert.match(source, /Усі цикли/);
  assert.match(source, /Усі підцикли/);
  assert.match(source, /Усі завдання/);
  assert.doesNotMatch(source, /Обрати картку/);
  assert.match(source, /work-advanced-filters/);
  assert.match(source, /Скинути фільтри/);
  assert.match(source, /Редагувати картку/);
  assert.match(source, /Координатор/);
  assert.match(source, /Керівник вищої ланки/);
  assert.match(source, /branchHasOpenBlocker/);
  assert.match(source, /filter === "manage".*branchHasOpenBlocker/);
  assert.match(source, /filter === "acceptance"/);
  assert.match(source, /item === "acceptance" \? "Приймаю"/);
  assert.doesNotMatch(source, /Власник результату|Приймає результат/);
  assert.doesNotMatch(source, /Робочий контур/);
  assert.match(source, /Координація за управлінськими циклами/);
  assert.match(source, /Предмет координації — зведений стан усіх завдань циклу/);
  assert.match(source, /Потребує координації/);
  assert.match(source, /Цикл без завдань/);
  assert.match(source, /три останні звіти/);
  assert.match(source, /slice\(0, 3\)/);
  assert.match(source, /Показати звіти/);
  assert.match(source, /Сховати звіти/);
  assert.match(source, /Згорнути рівні/);
  assert.match(source, /Розгорнути все/);
  assert.match(source, /Згорнути все/);
  assert.match(source, /toggleStructure/);
  assert.match(source, /toggleReports/);
  assert.match(source, /toggleEverything/);
  assert.match(source, /Стратегічна ціль → управлінський цикл → підцикл → завдання → три останні звіти/);
  assert.match(source, /useState<Set<string>>\(\(\) => new Set\(\)\)/);
  assert.match(source, /goals\.map\(\(goal\) => renderCoordinationRow\(goal\)\)/);
  assert.match(source, /Календар строків і координацій/);
  assert.match(source, /Перша координація/);
  assert.match(source, /Періодичність, днів/);
  assert.match(source, /Автоматично з нижчих рівнів/);
  assert.match(source, /label="Статус"/);
  assert.match(source, /selected\?\.kind === "cycle"/);
  assert.doesNotMatch(source, /Одиниця координації — підцикл/);
  assert.match(source, /Статус Завдання|parent\.health = state\.blockers/);
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
  assert.doesNotMatch(users, /body\.expectedRevision !== current\.revision/);
  assert.doesNotMatch(combined, /PORTAL_(OWNER|ADMIN)_PASSWORD\s*=/);
});

test("compact laptop and mobile layouts are declared", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 1366px\)/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(max-width: 520px\)/);
  assert.match(css, /\.tree-workbench\.compact-tree/);
  assert.match(css, /--tree-nav-width/);
  assert.match(css, /\.tree-filter-path/);
  assert.match(css, /\.coordination-tree-table/);
  assert.match(css, /\.calendar-grid/);
  assert.match(css, /\.tree-workbench\.mobile-pane-tree \.node-detail/);
  assert.match(css, /position: fixed; z-index: 90; top: auto; right: 0; bottom: 0/);
  assert.match(css, /\.coordination-card footer button\.primary/);
});
