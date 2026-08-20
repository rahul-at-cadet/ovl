CREATE TABLE `invalidation_notices` (
	`seq` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`version_no` integer NOT NULL,
	`broken_rules` text NOT NULL,
	`computed_at` text NOT NULL
);
