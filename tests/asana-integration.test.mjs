import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const noImports = (source) => source.replace(/^import .*;\n/gm, "");
const source = ["app/lib/asana-links.ts", "app/lib/asana-integration.ts"].map(async (path) => noImports(await readFile(new URL(`../${path}`, import.meta.url), "utf8")));
const compiled = ts.transpileModule((await Promise.all(source)).join("\n"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { ASANA_MANAGEMENT_TAG, asanaDueDate, primaryAsanaTitle, primaryAsanaRenameNeeded, portalTitleFromAsanaName, asanaTitleDiffers, portalMessageForAsana, portalReportForAsana, portalOriginId, portalTaskDescriptionForAsana } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("Asana due date follows the portal forecast, falling back to the planned deadline", () => {
  assert.equal(asanaDueDate({ forecastEnd: "2026-10-08", plannedEnd: "2026-10-02" }), "2026-10-08");
  assert.equal(asanaDueDate({ forecastEnd: "", plannedEnd: "2026-10-02" }), "2026-10-02");
  assert.equal(asanaDueDate({ forecastEnd: "", plannedEnd: "" }), "");
});

test("a primary Asana task uses the management code and title", () => {
  const node = { code: "P1.1.1", title: "Контроль публікацій" };
  assert.equal(primaryAsanaTitle(node), "P1.1.1 Контроль публікацій");
  assert.equal(asanaTitleDiffers(node, "P1.1.1 Контроль публікацій"), false);
  assert.equal(asanaTitleDiffers(node, "Контроль публікацій"), true);
  assert.equal(ASANA_MANAGEMENT_TAG, "Управлінський_цикл");
  assert.equal(portalTitleFromAsanaName(node, "P1.1.1 Контроль публікацій"), "Контроль публікацій");
  assert.equal(portalTitleFromAsanaName(node, "Інша назва"), "Інша назва");
});

test("only a renamed card with the same primary Asana task needs an automatic rename", () => {
  const before = { kind: "task", code: "P1.1.1", title: "Стара назва", asana: { taskGid: "123456789" } };
  assert.equal(primaryAsanaRenameNeeded(before, { ...before, title: "Нова назва" }), true);
  assert.equal(primaryAsanaRenameNeeded(before, { ...before, code: "P1.1.2" }), true);
  assert.equal(primaryAsanaRenameNeeded(before, { ...before, title: "Стара назва" }), false);
  assert.equal(primaryAsanaRenameNeeded(before, { ...before, asana: { taskGid: "987654321" } }), false);
  assert.equal(primaryAsanaRenameNeeded(before, { ...before, deletedAt: "2026-10-07" }), false);
  assert.equal(primaryAsanaRenameNeeded({ ...before, kind: "goal" }, { ...before, kind: "goal", title: "Нова назва" }), false);
});

test("an action is escaped and contains a real Asana mention and portal link", () => {
  const id = "5c74020a-6411-4c11-a8eb-f6cb1cfa7048";
  const html = portalMessageForAsana({ id, kind: "question", text: "Що з <договором> & строком?" }, "Едгар", "https://portal.example/?view=my&node=1&focus=discussion", "123456");
  assert.match(html, /<a data-asana-gid="123456"\/>/);
  assert.match(html, /&lt;договором&gt; &amp; строком/);
  assert.match(html, /focus=discussion/);
  assert.equal(portalOriginId(html), id);
});

test("a portal report carries an origin marker to prevent an import loop", () => {
  const id = "5c74020a-6411-4c11-a8eb-f6cb1cfa7048";
  const html = portalReportForAsana({ id, summary: "Готово", nextAction: "Погодити" }, "Едгар", "https://portal.example/");
  assert.match(html, /Звіт/);
  assert.match(html, /Погодити/);
  assert.equal(portalOriginId(html), id);
});

const node = (id, kind, parentId, extra = {}) => ({ id, kind, parentId, code: id, title: `Назва ${id}`, controlPlace: "", result: "Готовий результат", acceptanceCriteria: "Погоджено", asana: { taskGid: "", taskUrl: "" }, ...extra });
const structureFixture = () => [
  node("S1", "goal", null, { asana: { taskGid: "123456789", taskUrl: "https://app.asana.com/0/12345678/123456789" } }),
  node("P1", "cycle", "S1", { asana: { taskGid: "234567890", taskUrl: "" } }),
  node("P1.1", "subcycle", "P1", { controlPlace: "https://app.asana.com/1/12345678/project/23456789/task/345678901" }),
  node("P1.1.1", "task", "P1.1", { title: 'Завдання <база> & "дані"' }),
];

test("description replaces its plain path with ordered linked levels and preserves the passport once", () => {
  const nodes = structureFixture();
  const html = portalTaskDescriptionForAsana(nodes, nodes[3], "ПАСПОРТ КАРТКИ ПОРТАЛУ\n\nМІСЦЕ В СТРУКТУРІ\nШлях: OLD PATH\nРівень: Завдання\n\nРЕЗУЛЬТАТ І МЕЖІ\nОпис: <готово> & без змін\nДедлайн до - 30 вер. 2026");
  assert.match(html, /^<body>[\s\S]*<\/body>$/);
  assert.match(html, /<a href="https:\/\/app.asana.com\/0\/12345678\/123456789" data-asana-gid="123456789" data-asana-dynamic="false">Стратегічна ціль: S1 · Назва S1<\/a>/);
  assert.match(html, /<a href="https:\/\/app.asana.com\/0\/0\/234567890" data-asana-gid="234567890" data-asana-dynamic="false">Напрям зусиль: P1 · Назва P1<\/a>/);
  assert.match(html, /<a href="https:\/\/app.asana.com\/1\/12345678\/project\/23456789\/task\/345678901" data-asana-gid="345678901" data-asana-dynamic="false">Проект: P1.1 · Назва P1.1<\/a>/);
  assert.doesNotMatch(html, /<br/);
  assert.match(html, /Завдання: P1.1.1 · Завдання &lt;база&gt; &amp; &quot;дані&quot;/);
  assert.match(html, /Опис: &lt;готово&gt; &amp; без змін/);
  assert.match(html, /Дедлайн до - 30 вер. 2026/);
  assert.equal((html.match(/МІСЦЕ В СТРУКТУРІ/g) || []).length, 1);
  assert.doesNotMatch(html, /OLD PATH/);
  assert.ok(html.indexOf("Стратегічна ціль") < html.indexOf("Напрям зусиль"));
  assert.ok(html.indexOf("Проект:") < html.indexOf("Завдання:"));
});

test("direct tasks, unlinked levels and missing or cyclic parents are handled without fictitious levels", () => {
  const nodes = structureFixture();
  nodes[3].parentId = "P1";
  let html = portalTaskDescriptionForAsana(nodes, nodes[3]);
  assert.doesNotMatch(html, /Проект:/);
  assert.match(html, /Критерій приймання: Погоджено/);
  nodes[1].parentId = "P1.1.1";
  html = portalTaskDescriptionForAsana(nodes, nodes[3]);
  assert.equal((html.match(/Напрям зусиль:/g) || []).length, 1);
  nodes[1].deletedAt = "2026-09-29";
  html = portalTaskDescriptionForAsana(nodes, nodes[3]);
  assert.doesNotMatch(html, /Напрям зусиль:|Стратегічна ціль:/);
});

test("structure links reject unsafe, project-only and ambiguous URLs and prefer the explicit main task", () => {
  const root = node("S1", "goal", null, { asana: { taskGid: "123456789", taskUrl: "https://app.asana.com/0/12345678/999999999" }, controlPlace: "https://app.asana.com/0/12345678/234567890" });
  assert.match(portalTaskDescriptionForAsana([root], root), /href="https:\/\/app.asana.com\/0\/0\/123456789"/);
  root.asana = { taskGid: "", taskUrl: "javascript:alert(1)" };
  root.controlPlace = "https://app.asana.com/0/12345678/234567890 https://app.asana.com/0/12345678/345678901";
  assert.doesNotMatch(portalTaskDescriptionForAsana([root], root), /<a /);
  for (const value of ["javascript:alert(1)", "https://evil.example/0/12345678/234567890", "https://app.asana.com/1/12345678/project/234567890"]) {
    root.controlPlace = value;
    assert.doesNotMatch(portalTaskDescriptionForAsana([root], root), /<a /);
  }
});
