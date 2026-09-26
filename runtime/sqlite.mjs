import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

// The application expects the D1 subset below. Every batch is one SQLite
// transaction, including the revision check and its dependent audit writes.
export function openPortalDatabase(path) {
  if (!path || !existsSync(path)) throw new Error("An existing PORTAL_SQLITE_PATH is required; refusing to seed a missing production database");
  const connection = new DatabaseSync(path);
  connection.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  function statement(sql, values = []) {
    const execute = () => {
      const query = connection.prepare(sql);
      const reads = query.columns().length > 0;
      if (reads) return { success: true, results: query.all(...values), meta: { changes: 0 } };
      const result = query.run(...values);
      return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    };
    return {
      bind(...args) { return statement(sql, args); },
      async first(column) {
        const row = connection.prepare(sql).get(...values);
        return row ? (column ? row[column] : row) : null;
      },
      async all() { return execute(); },
      async run() { return execute(); },
      execute,
    };
  }
  return {
    prepare: statement,
    async batch(statements) {
      connection.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(query => query.execute());
        connection.exec("COMMIT");
        return results;
      } catch (error) { connection.exec("ROLLBACK"); throw error; }
    },
    close() { connection.close(); },
  };
}
