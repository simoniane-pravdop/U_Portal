import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8");

test("the control-place add button creates another row even when the first one is empty", () => {
  assert.match(app, /onClick=\{\(\) => update\("controlPlace", `\$\{node\.controlPlace\}\\n`\)\}/);
  assert.match(app, /aria-label="Додати ще одне контрольне місце">\+ місце/);
});

test("projects expose a separate Asana task action and work-card panel", () => {
  assert.match(app, /selected\.kind === "subcycle" && <button className="secondary" onClick=\{\(\) => openWork\(selected, "asana"\)\}>Створити \/ прив’язати задачу Asana/);
  assert.match(app, /current\.kind === "subcycle" && <AsanaSyncPanel/);
  assert.match(app, /focusTarget === "asana" \? `asana-link-\$\{current\.id\}`/);
  assert.match(app, /node\.kind === "task" && node\.asana\.rules\.status === "asana"/);
});
