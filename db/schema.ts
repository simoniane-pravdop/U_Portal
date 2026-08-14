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

export const portalCredentials = sqliteTable("portal_credentials", {
  userId: text("user_id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  passwordIterations: integer("password_iterations").notNull(),
  mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  createdBy: text("created_by").notNull(),
});

export const portalLoginAttempts = sqliteTable("portal_login_attempts", {
  identifier: text("identifier").primaryKey(),
  failedCount: integer("failed_count").notNull().default(0),
  firstFailedAt: text("first_failed_at").notNull(),
  lockedUntil: text("locked_until").notNull().default(""),
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

export const telegramLinks = sqliteTable("telegram_links", {
  userId: text("user_id").primaryKey(),
  chatId: text("chat_id").notNull().unique(),
  telegramUserId: text("telegram_user_id").notNull(),
  telegramUsername: text("telegram_username").notNull().default(""),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  linkedAt: text("linked_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const telegramLinkCodes = sqliteTable("telegram_link_codes", {
  codeHash: text("code_hash").primaryKey(),
  userId: text("user_id").notNull(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at").notNull().default(""),
  createdAt: text("created_at").notNull(),
});

export const telegramEvents = sqliteTable("telegram_events", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  direction: text("direction").notNull(),
  status: text("status").notNull(),
  summary: text("summary").notNull(),
  createdAt: text("created_at").notNull(),
});
