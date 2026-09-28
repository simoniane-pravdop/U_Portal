import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/lib/portal-routes.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { portalPaths, portalHref, portalViewForPath, readPortalRoute, canonicalPortalUrl } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("every section has a distinct transliterated path and accepts direct links", () => {
  assert.equal(portalHref("ideas"), "/idei");
  assert.equal(new Set(Object.values(portalPaths)).size, 8);
  for (const [view, path] of Object.entries(portalPaths)) {
    assert.match(path, /^\/[a-z-]+$/);
    assert.equal(portalHref(view), path);
    assert.equal(portalViewForPath(`${path}/`), view);
    assert.equal(readPortalRoute(new URL(`https://portal.test${path}`)).view, view);
    assert.equal(readPortalRoute(new URL(`https://portal.test${path}?view=settings`)).view, view);
  }
  assert.equal(portalViewForPath("/not-a-section"), undefined);
  assert.equal(portalViewForPath("/api/state"), undefined);
});

test("all old query links remain readable and canonicalize without duplicate history entries", () => {
  for (const [view, path] of Object.entries(portalPaths)) {
    const url = new URL(`https://portal.test/?view=${view}`);
    assert.equal(readPortalRoute(url).view, view);
    assert.equal(canonicalPortalUrl(url, view), path);
  }
  assert.equal(readPortalRoute(new URL("https://portal.test/")).view, "dashboard");
  assert.equal(readPortalRoute(new URL("https://portal.test/?view=__proto__")).view, "dashboard");
});

test("card identifiers and action targets survive encoding, reload and history parsing", () => {
  const id = "node/1 &2";
  for (const focus of ["blocker", "decision", "acceptance", "discussion", "reports"]) {
    const href = portalHref("my", id, focus);
    const url = new URL(href, "https://portal.test");
    assert.equal(url.pathname, "/moia-robota");
    assert.deepEqual(readPortalRoute(url), { view: "my", nodeId: id, focus });
    assert.deepEqual(readPortalRoute(new URL(`https://portal.test/?view=my&node=${encodeURIComponent(id)}&focus=${focus}`)), { view: "my", nodeId: id, focus });
  }
  assert.deepEqual(readPortalRoute(new URL(portalHref("tree", id), "https://portal.test")), { view: "tree", nodeId: id, focus: null });
});

test("section changes remove stale card targets but preserve OAuth flags and hashes", () => {
  const url = new URL("https://portal.test/?view=my&node=1&focus=decision&asana=connected#main-content");
  assert.equal(canonicalPortalUrl(url, "settings", "1", "decision"), "/nalashtuvannia?asana=connected#main-content");
  assert.equal(canonicalPortalUrl(url, "tree", "1", "decision"), "/derevo-tsilei?node=1&asana=connected#main-content");
  assert.equal(canonicalPortalUrl(url, "my"), "/moia-robota?asana=connected#main-content");
  assert.equal(readPortalRoute(new URL("https://portal.test/moia-robota?node=1&focus=invalid")).focus, null);
  assert.equal(readPortalRoute(new URL("https://portal.test/idei?node=1")).nodeId, "");
});

test("client navigation uses paths, restores card context on back, and shares canonical links", async () => {
  const ui = await readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8");
  assert.match(ui, /window\.history\.replaceState/);
  assert.match(ui, /window\.history\.pushState/);
  assert.match(ui, /readPortalRoute\(new URL\(window.location.href\)\)/);
  assert.match(ui, /setWorkEntryFocus\(resolvedView === "my" \? route.focus : null\)/);
  assert.match(ui, /new URL\(portalHref\(targetView, node.id\), window.location.origin\)/);
  assert.doesNotMatch(ui, /searchParams.set\("view"|\/\?view=/);
});
