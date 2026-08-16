CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`sender` text NOT NULL,
	`body` text NOT NULL,
	`sent_at` text NOT NULL,
	`direction` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`can_submit` integer DEFAULT false NOT NULL,
	`must_change_password` integer DEFAULT true NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);