CREATE TABLE `portal_edit_locks` (
  `entity_id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `user_name` text NOT NULL,
  `acquired_at` text NOT NULL,
  `expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_portal_edit_locks_expires` ON `portal_edit_locks` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `portal_entity_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `entity_id` text NOT NULL,
  `revision` integer NOT NULL,
  `user_id` text NOT NULL,
  `user_name` text NOT NULL,
  `action` text NOT NULL,
  `payload` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_portal_entity_versions_entity_revision` ON `portal_entity_versions` (`entity_id`,`revision`);
