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
  const asanaLinks = jsx ? await loadComponent("../app/lib/asana-links.ts") : null;
  const localRequire = (specifier) => specifier === "../lib/asana-links" ? asanaLinks : require(specifier);
  new Function("require", "module", "exports", outputText)(localRequire, runtimeModule, runtimeModule.exports);
  return runtimeModule.exports;
}

test("management codes sort numerically, independent of creation date", async () => {
  const { compareNodeCodes } = await loadComponent("../app/lib/node-order.ts");
  const items = ["P10", "P2", "P1.10", "P1.2", "P1", "P8"].map((code) => ({ code, title: code }));
  assert.deepEqual(items.sort(compareNodeCodes).map((item) => item.code), ["P1", "P1.2", "P1.10", "P2", "P8", "P10"]);
});

test("actual milestones are hidden from direction and project cards, but remain on tasks", async () => {
  const { showActualMilestones } = await loadComponent("../app/lib/node-date-visibility.ts");
  assert.equal(showActualMilestones("cycle"), false);
  assert.equal(showActualMilestones("subcycle"), false);
  assert.equal(showActualMilestones("goal"), true);
  assert.equal(showActualMilestones("task"), true);
  const source = await readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8");
  assert.match(source, /showActualMilestones\(node\.kind\)/);
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

test("Asana links display the task title when known, with an honest fallback", async () => {
  const { asanaTaskGid, asanaLinkLabel } = await loadComponent("../app/lib/asana-links.ts");
  const url = "https://app.asana.com/1/50916733923098/project/50916733923101/task/1215492457102253";
  assert.equal(asanaTaskGid(url), "1215492457102253");
  assert.equal(asanaTaskGid("https://evil-asana.com/task/1215492457102253"), null);
  assert.equal(asanaLinkLabel(url, "Актуалізувати базу знань"), "Актуалізувати базу знань");
  assert.match(asanaLinkLabel(url), /назву ще не отримано/);
  const { LinkedText } = await loadComponent("../app/components/LinkedText.tsx", true);
  const html = renderToStaticMarkup(createElement(LinkedText, { value: `Контрольне місце: ${url}`, asanaTitles: { [url]: "Актуалізувати базу знань" } }));
  assert.match(html, /href="https:\/\/app\.asana\.com\/1\/50916733923098\/project\/50916733923101\/task\/1215492457102253"/);
  assert.match(html, />Актуалізувати базу знань<\/a>/);
  assert.doesNotMatch(html, />https:\/\/app\.asana\.com/);
});

test("creation metadata uses the saved author and timestamp, with an audit-only legacy fallback", async () => {
  const { nodeCreation } = await loadComponent("../app/lib/node-creation.ts");
  const audit = [{ entityId: "node-1", action: "Створено P1.1", by: "Початковий автор", at: "2026-08-25T13:00:00.000Z" }];
  const users = [{ id: "author-1", name: "Едгар Сімонян" }];
  assert.deepEqual(nodeCreation({ id: "node-1", createdById: "author-1", createdAt: "2026-09-22T10:00:00.000Z" }, audit, users), { name: "Едгар Сімонян", at: "2026-09-22T10:00:00.000Z" });
  assert.deepEqual(nodeCreation({ id: "node-1", createdAt: "2026-08-24T10:00:00.000Z" }, audit, users), { name: "Початковий автор", at: "2026-08-25T13:00:00.000Z" });
  assert.deepEqual(nodeCreation({ id: "node-2", createdAt: "2026-08-24T10:00:00.000Z" }, audit, users), { name: "Не зафіксовано", at: "" });
  const route = await readFile(new URL("../app/api/state/route.ts", import.meta.url), "utf8");
  assert.match(route, /node\.createdAt = savedAt/);
  assert.match(route, /node\.createdById = user\.id/);
  assert.match(route, /node\.createdAt = before\.createdAt/);
});

test("tree passport opens filled fields before the work snapshot", async () => {
  const source = await readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8");
  const passport = source.indexOf('<WorkCardDescription node={selected} payload={payload} userById={userById} expanded />');
  const snapshot = source.indexOf('<TreeWorkSnapshot node={selected} payload={payload} userById={userById} />');
  assert.ok(passport > 0 && snapshot > passport);
  for (const field of ["node.description", "node.result", "node.acceptanceCriteria", "node.authority", "node.resource", "node.controlPlace"]) {
    assert.ok(source.slice(source.indexOf("function WorkCardDescription("), source.indexOf("function AcceptanceActionBox(")).includes(field));
  }
  assert.match(source, /<section key=\{selected\.id\} className="node-detail">/);
  assert.match(source, /if \(expanded\) return <section className="work-card-description tree-passport">/);
});

test("saved Asana links remain available independently of account connection", async () => {
  const { asanaLinks } = await loadComponent("../app/lib/asana-links.ts");
  assert.deepEqual(asanaLinks("Asana · https://app.asana.com/0/123/456.\nhttps://app.asana.com/0/123/456", "https://evil-asana.com/0/1", "https://asana.com/0/7/8"), ["https://app.asana.com/0/123/456", "https://asana.com/0/7/8"]);
  const source = await readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8");
  assert.ok(source.indexOf("{savedAsanaLinks.length > 0 && <div className=\"asana-saved-links\">") < source.indexOf("{!asanaStatus?.connected ? <div className=\"asana-empty\">"));
  assert.match(source, /savedAsanaLinks = asanaLinks\(selected\.controlPlace, selected\.description\)/);
  assert.match(source, /savedAsanaLinks = asanaLinks\(node\.controlPlace, node\.description, node\.asana\.taskUrl\)/);
});

test("Asana task names are read from a shared title cache without borrowing another user's connection", async () => {
  const route = await readFile(new URL("../app/api/asana/titles/route.ts", import.meta.url), "utf8");
  const source = await readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8");
  assert.match(route, /SELECT task_gid, name, updated_at FROM asana_task_titles/);
  assert.match(route, /SELECT user_id FROM asana_connections WHERE user_id = \?/);
  assert.match(route, /asanaRequest\(user\.id,/);
  assert.match(source, /const titles = useAsanaTitles\(selected\)/);
  assert.match(source, /asanaLinkLabel\(url, titles\[url\]\)/);
  assert.match(source, /aria-expanded=\{hasChildren \? expanded\.has\(node\.id\) : undefined\}/);
  assert.match(source, /aria-expanded=\{hasChildren \? opened : undefined\}/);
});

test("portal navigation exposes actual links and coordination opens cards in a new tab", async () => {
  const source = await readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8");
  assert.match(source, /className=\{`nav-item nav-\$\{item\.id\}/);
  assert.match(source, /href=\{portalHref\("tree", node\.id\)\}/);
  assert.match(source, /href=\{portalHref\("my", node\.id\)\}/);
  assert.match(source, /href=\{cardHref\(node, payload\.currentUser\)\} target="_blank"/);
});
