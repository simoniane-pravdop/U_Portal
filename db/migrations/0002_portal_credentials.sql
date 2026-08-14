CREATE TABLE `portal_credentials` (
  `user_id` text PRIMARY KEY NOT NULL,
  `email` text NOT NULL,
  `password_hash` text NOT NULL,
  `password_salt` text NOT NULL,
  `password_iterations` integer NOT NULL,
  `must_change_password` integer DEFAULT false NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `created_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `portal_credentials_email_unique` ON `portal_credentials` (`email`);
--> statement-breakpoint
CREATE TABLE `portal_login_attempts` (
  `identifier` text PRIMARY KEY NOT NULL,
  `failed_count` integer DEFAULT 0 NOT NULL,
  `first_failed_at` text NOT NULL,
  `locked_until` text DEFAULT '' NOT NULL
);
