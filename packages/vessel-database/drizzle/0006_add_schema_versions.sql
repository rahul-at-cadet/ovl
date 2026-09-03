CREATE TABLE `schema_versions` (
	`schema_name` text NOT NULL,
	`version` text NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`content` text NOT NULL,
	`published_at` text NOT NULL,
	`received_at` text NOT NULL,
	PRIMARY KEY(`schema_name`, `version`)
);
