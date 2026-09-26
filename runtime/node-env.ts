import { openPortalDatabase } from "./sqlite.mjs";

let database: ReturnType<typeof openPortalDatabase> | undefined;
// No production Asana/Telegram secrets are installed on the independent copy.
// FILES remains unavailable, as on the current free-tier Worker deployment.
export const env = new Proxy<Record<string, unknown>>({}, {
  get(_target, name) {
    if (name === "DB") {
      database ??= openPortalDatabase(process.env.PORTAL_SQLITE_PATH);
      return database;
    }
    if (name === "FILES") return undefined;
    return typeof name === "string" ? process.env[name] : undefined;
  },
});
