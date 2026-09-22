import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);

async function loadComponent(path, jsx = false) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: jsx ? ts.JsxEmit.ReactJSX : undefined,
    },
  });
  const runtimeModule = { exports: {} };
  new Function("require", "module", "exports", outputText)(require, runtimeModule, runtimeModule.exports);
  return runtimeModule.exports;
}

test("management codes sort numerically, independent of creation date", async () => {
  const { compareNodeCodes } = await loadComponent("../app/lib/node-order.ts");
  const items = ["P10", "P2", "P1.10", "P1.2", "P1", "P8"].map((code) => ({ code, title: code }));
  assert.deepEqual(items.sort(compareNodeCodes).map((item) => item.code), ["P1", "P1.2", "P1.10", "P2", "P8", "P10"]);
});

test("Asana links in filled card fields are clickable and safe", async () => {
  const { LinkedText } = await loadComponent("../app/components/LinkedText.tsx", true);
  const html = renderToStaticMarkup(createElement(LinkedText, { value: "Asana · https://app.asana.com/0/123/456. Інше: javascript:alert(1) <script>" }));
  assert.match(html, /href="https:\/\/app\.asana\.com\/0\/123\/456"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, />https:\/\/app\.asana\.com\/0\/123\/456<\/a>\./);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /&lt;script&gt;/);
});

test("tree passport opens filled fields before the work snapshot", async () => {
  const source = await readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8");
  const passport = source.indexOf('<WorkCardDescription key={selected.id} node={selected} payload={payload} userById={userById} expanded />');
  const snapshot = source.indexOf('<TreeWorkSnapshot node={selected} payload={payload} userById={userById} />');
  assert.ok(passport > 0 && snapshot > passport);
  for (const field of ["node.description", "node.result", "node.acceptanceCriteria", "node.authority", "node.resource", "node.controlPlace"]) {
    assert.ok(source.slice(source.indexOf("function WorkCardDescription("), source.indexOf("function AcceptanceActionBox(")).includes(field));
  }
});
