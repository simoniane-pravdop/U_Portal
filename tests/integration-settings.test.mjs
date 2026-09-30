import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openPortalDatabase } from "../runtime/sqlite.mjs";

test("integration settings stay in the existing portal database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "u-portal-integrations-"));
  const path = join(directory, "portal.sqlite");
  try {
    const seed = new DatabaseSync(path);
    seed.exec("CREATE TABLE portal_integration_settings (name TEXT PRIMARY KEY, encrypted_value TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL)");
    seed.close();
    const db = openPortalDatabase(path);
    assert.equal(db.integrationSetting("ASANA_CLIENT_SECRET"), null);
    await db.prepare("INSERT INTO portal_integration_settings VALUES (?, ?, ?, ?)").bind("ASANA_CLIENT_SECRET", "encrypted-only", "admin", new Date().toISOString()).run();
    assert.equal(db.integrationSetting("ASANA_CLIENT_SECRET"), "encrypted-only");
    assert.equal(db.integrationSetting("TELEGRAM_BOT_TOKEN"), null);
    db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
