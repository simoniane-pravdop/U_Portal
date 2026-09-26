import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";

// Run inside the dedicated portal container. No other application's DB is read.
const directory = "/data/backups";
mkdirSync(directory, { recursive: true, mode: 0o700 });
const path = `${directory}/portal-${new Date().toISOString().replaceAll(":", "-")}.sqlite`;
const db = new DatabaseSync(process.env.PORTAL_SQLITE_PATH);
db.exec("PRAGMA busy_timeout=10000;");
db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
db.close();
chmodSync(path, 0o600);
console.log(path);
