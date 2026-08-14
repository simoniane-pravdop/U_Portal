import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const portalState = sqliteTable("portal_state", {
  id: text("id").primaryKey(),
  payload: text("payload").notNull(),
  revision: integer("revision").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by").notNull(),
});

export const portalSessions = sqliteTable("portal_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  authMode: text("auth_mode").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const asanaConnections = sqliteTable("asana_connections", {
  userId: text("user_id").primaryKey(),
  asanaUserGid: text("asana_user_gid").notNull(),
  asanaUserName: text("asana_user_name").notNull(),
  encryptedAccessToken: text("encrypted_access_token").notNull(),
  encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
  expiresAt: text("expires_at").notNull(),
  scope: text("scope").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const syncEvents = sqliteTable("sync_events", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  nodeId: text("node_id").notNull(),
  direction: text("direction").notNull(),
  status: text("status").notNull(),
  summary: text("summary").notNull(),
  createdAt: text("created_at").notNull(),
});
