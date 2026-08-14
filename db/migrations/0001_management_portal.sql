CREATE TABLE `portal_state` (
  `id` text PRIMARY KEY NOT NULL,
  `payload` text NOT NULL,
  `revision` integer DEFAULT 1 NOT NULL,
  `updated_at` text NOT NULL,
  `updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `portal_sessions` (
  `token_hash` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `email` text NOT NULL,
  `name` text NOT NULL,
  `auth_mode` text NOT NULL,
  `expires_at` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_portal_sessions_expires_at` ON `portal_sessions` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `asana_connections` (
  `user_id` text PRIMARY KEY NOT NULL,
  `asana_user_gid` text NOT NULL,
  `asana_user_name` text NOT NULL,
  `encrypted_access_token` text NOT NULL,
  `encrypted_refresh_token` text NOT NULL,
  `expires_at` text NOT NULL,
  `scope` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_events` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `node_id` text NOT NULL,
  `direction` text NOT NULL,
  `status` text NOT NULL,
  `summary` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sync_events_user_created` ON `sync_events` (`user_id`, `created_at`);
