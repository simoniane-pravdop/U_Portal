import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/lib/asana-integration.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { ASANA_MANAGEMENT_TAG, primaryAsanaTitle, asanaTitleDiffers, portalMessageForAsana, portalReportForAsana, portalOriginId } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("a primary Asana task uses the management code and title", () => {
  const node = { code: "P1.1.1", title: "Контроль публікацій" };
  assert.equal(primaryAsanaTitle(node), "P1.1.1 Контроль публікацій");
  assert.equal(asanaTitleDiffers(node, "P1.1.1 Контроль публікацій"), false);
  assert.equal(asanaTitleDiffers(node, "Контроль публікацій"), true);
  assert.equal(ASANA_MANAGEMENT_TAG, "Управлінський_цикл");
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
