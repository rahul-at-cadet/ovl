CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`outcome` text NOT NULL,
	`trigger` text NOT NULL,
	`push_error` text,
	`config_error` text,
	`config_notice` text,
	`pushed_count` integer DEFAULT 0 NOT NULL,
	`bundle_id_before` text,
	`bundle_id_after` text,
	`bundle_version_after` integer
);
