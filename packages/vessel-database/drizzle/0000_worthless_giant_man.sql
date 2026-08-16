CREATE TABLE `config_store` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `report_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`report_id` text NOT NULL,
	`version_no` integer NOT NULL,
	`type` text NOT NULL,
	`at` text NOT NULL,
	`actor` text DEFAULT '' NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`report_id` text NOT NULL,
	`version_no` integer NOT NULL,
	`schema_name` text NOT NULL,
	`event_type` text NOT NULL,
	`event_time` text NOT NULL,
	`fields` text NOT NULL,
	`state` text NOT NULL,
	`invalidated_from` text DEFAULT '' NOT NULL,
	`invalidated_rules` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`submitted_at` text,
	`submitted_by` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`report_id`, `version_no`)
);
--> statement-breakpoint
CREATE TABLE `sync_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	`processed_at` text
);
