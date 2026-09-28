import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/lib/menu-position.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const mod = { exports: {} };
new Function("module", "exports", compiled)(mod, mod.exports);
const { menuPosition } = mod.exports;
const menu = { width: 230, height: 230 };

test("card actions align below the trigger when there is room", () => {
  assert.deepEqual(menuPosition({ left: 900, right: 1000, top: 50, bottom: 90 }, menu, { width: 1280, height: 800 }), { left: 770, top: 96 });
});
test("card actions open above a low trigger rather than below the viewport", () => {
  assert.deepEqual(menuPosition({ left: 900, right: 1000, top: 650, bottom: 690 }, menu, { width: 1280, height: 800 }), { left: 770, top: 414 });
});
test("card actions stay within both horizontal edges", () => {
  assert.equal(menuPosition({ left: 0, right: 50, top: 50, bottom: 90 }, menu, { width: 640, height: 800 }).left, 8);
  assert.equal(menuPosition({ left: 1000, right: 1100, top: 50, bottom: 90 }, menu, { width: 640, height: 800 }).left, 402);
});
test("card actions clamp their position in a short window", () => {
  assert.deepEqual(menuPosition({ left: 900, right: 1000, top: 80, bottom: 120 }, menu, { width: 1280, height: 260 }), { left: 770, top: 8 });
});
