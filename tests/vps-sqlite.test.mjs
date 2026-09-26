import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPortalDatabase } from "../runtime/sqlite.mjs";

test("VPS adapter fails closed if the production snapshot is missing", () => {
  assert.throws(() => openPortalDatabase("/missing/portal.sqlite"), /refusing to seed/);
});
test("VPS adapter preserves first, all, CAS changes and atomic batch rollback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "portal-sqlite-test-"));
  const file = join(dir, "portal.sqlite");
  writeFileSync(file, "");
  const db = openPortalDatabase(file);
  try {
    await db.prepare("CREATE TABLE records(id TEXT PRIMARY KEY, revision INTEGER)").run();
    await db.prepare("INSERT INTO records VALUES (?, ?)").bind("main", 1).run();
    assert.equal(await db.prepare("SELECT revision FROM records WHERE id=?").bind("main").first("revision"), 1);
    assert.equal((await db.prepare("UPDATE records SET revision=2 WHERE revision=1").run()).meta.changes, 1);
    assert.equal((await db.prepare("UPDATE records SET revision=3 WHERE revision=1").run()).meta.changes, 0);
    await assert.rejects(db.batch([
      db.prepare("UPDATE records SET revision=9"),
      db.prepare("INSERT INTO records VALUES('main',1)"),
    ]));
    assert.equal((await db.prepare("SELECT revision FROM records").first()).revision, 2);
    const results = await db.batch([db.prepare("UPDATE records SET revision=3"), db.prepare("SELECT revision FROM records")]);
    assert.equal(results[0].meta.changes, 1);
    assert.equal(results[1].results[0].revision, 3);
  } finally { db.close(); rmSync(dir, {recursive:true, force:true}); }
});
