CREATE TABLE `form_schemas` (
	`schema_name` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`checksum` text NOT NULL,
	`content` text NOT NULL,
	`synced_at` text NOT NULL
);
