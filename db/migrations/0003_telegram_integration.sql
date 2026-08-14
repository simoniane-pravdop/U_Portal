CREATE TABLE `telegram_links` (
  `user_id` text PRIMARY KEY NOT NULL,
  `chat_id` text NOT NULL,
  `telegram_user_id` text NOT NULL,
  `telegram_username` text DEFAULT '' NOT NULL,
  `active` integer DEFAULT true NOT NULL,
  `linked_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_links_chat_id_unique` ON `telegram_links` (`chat_id`);
--> statement-breakpoint
CREATE TABLE `telegram_link_codes` (
  `code_hash` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `expires_at` text NOT NULL,
  `used_at` text DEFAULT '' NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_telegram_link_codes_user` ON `telegram_link_codes` (`user_id`, `expires_at`);
--> statement-breakpoint
CREATE TABLE `telegram_events` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `direction` text NOT NULL,
  `status` text NOT NULL,
  `summary` text NOT NULL,
  `created_at` text NOT NULL
);
