import { openPortalDatabase } from "./sqlite.mjs";
import { createDecipheriv } from "node:crypto";

let database: ReturnType<typeof openPortalDatabase> | undefined;
const integrationNames = new Set(["ASANA_CLIENT_ID", "ASANA_CLIENT_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"]);

function integrationValue(name: string) {
  const encrypted = database?.integrationSetting(name);
  if (!encrypted) return undefined;
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY || "", "base64");
  if (key.byteLength !== 32) return undefined;
  const packed = Buffer.from(String(encrypted), "base64");
  if (packed.byteLength < 29) return undefined;
  const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(-16));
  return Buffer.concat([decipher.update(packed.subarray(12, -16)), decipher.final()]).toString("utf8");
}

// FILES remains unavailable, as on the current free-tier Worker deployment.
export const env = new Proxy<Record<string, unknown>>({}, {
  get(_target, name) {
    if (name === "DB") {
      database ??= openPortalDatabase(process.env.PORTAL_SQLITE_PATH);
      return database;
    }
    if (name === "FILES") return undefined;
    if (typeof name === "string" && integrationNames.has(name)) {
      database ??= openPortalDatabase(process.env.PORTAL_SQLITE_PATH);
      try { return integrationValue(name) || process.env[name]; } catch { return process.env[name]; }
    }
    return typeof name === "string" ? process.env[name] : undefined;
  },
});
