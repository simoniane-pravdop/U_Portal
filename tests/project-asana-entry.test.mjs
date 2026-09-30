import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8");

test("the control-place add button creates another row even when the first one is empty", () => {
  assert.match(app, /onClick=\{\(\) => update\("controlPlace", `\$\{node\.controlPlace\}\\n`\)\}/);
  assert.match(app, /aria-label="Додати ще одне контрольне місце">\+ місце/);
});

test("directions, projects and tasks expose hierarchical Asana creation", () => {
  assert.match(app, /node\.kind !== "goal" && <button onClick=\{saveAndCreateAsana\}>\{node\.asana\.taskGid \? "Зберегти → відкрити Asana" : "Зберегти → створити в Asana"\}<\/button>/);
  assert.match(app, /if \(openAsanaAfterSave\) openNodeInWork\(updated, "asana"\)/);
  assert.match(app, /selected\.kind !== "goal" && <button className="secondary" onClick=\{\(\) => openWork\(selected, "asana"\)\}>/);
  assert.match(app, /\["subcycle", "cycle"\]\.includes\(current\.kind\) && <AsanaSyncPanel/);
  assert.match(app, /asanaParentNode\(payload\.nodes, selected\)/);
  assert.match(app, /focusTarget === "asana" \? `asana-link-\$\{current\.id\}`/);
  assert.match(app, /node\.kind === "task" && node\.asana\.rules\.status === "asana"/);
});
