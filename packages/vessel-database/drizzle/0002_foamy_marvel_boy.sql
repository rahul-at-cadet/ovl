CREATE TABLE `remarks` (
	`id` text PRIMARY KEY NOT NULL,
	`remark_set_id` text NOT NULL,
	`report_id` text NOT NULL,
	`version_no` integer NOT NULL,
	`field_name` text NOT NULL,
	`body` text NOT NULL,
	`author` text NOT NULL,
	`created_at` text NOT NULL,
	`resolved` integer DEFAULT false NOT NULL,
	`resolved_at` text
);
