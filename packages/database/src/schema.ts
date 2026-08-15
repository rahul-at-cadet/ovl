import { pgTable, integer, bigint, boolean, timestamp, index, unique, uuid, text, jsonb, uniqueIndex, foreignKey, doublePrecision, bigserial, primaryKey, customType } from "drizzle-orm/pg-core"
  import { sql } from "drizzle-orm"


const bytea = customType<{ data: Buffer; driverData: string }>({
  dataType() {
    return 'bytea';
  },
  toDriver(val: Buffer): string {
    return '\\x' + val.toString('hex');
  },
  fromDriver(value: string): Buffer {
    if (typeof value === 'string' && value.startsWith('\\x')) {
      return Buffer.from(value.slice(2), 'hex');
    }
    return Buffer.from(value as any);
  },
});

export const gooseDbVersion = pgTable("goose_db_version", {
	id: integer("id").primaryKey().generatedByDefaultAsIdentity({ name: "goose_db_version_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 2147483647, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	versionId: bigint("version_id", { mode: "number" }).notNull(),
	isApplied: boolean("is_applied").notNull(),
	tstamp: timestamp("tstamp", { mode: 'string' }).defaultNow().notNull(),
});

export const vessels = pgTable("vessels", {
	id: uuid("id").primaryKey().notNull(),
	imo: text("imo").notNull(),
	name: text("name").notNull(),
	type: text("type").notNull(),
	groups: jsonb("groups").default([]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
},
(table) => {
	return {
		idxVesselsGroups: index("idx_vessels_groups").using("gin", table.groups.asc().nullsLast()),
		vesselsImoKey: unique("vessels_imo_key").on(table.imo),
	}
});

export const cadenceRules = pgTable("cadence_rules", {
	scopeType: text("scope_type").notNull(),
	vesselId: uuid("vessel_id"),
	groupTag: text("group_tag"),
	minReportIntervalHours: doublePrecision("min_report_interval_hours").notNull(),
	maxGapHours: doublePrecision("max_gap_hours").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
},
(table) => {
	return {
		uxCadenceRulesFleet: uniqueIndex("ux_cadence_rules_fleet").using("btree", table.scopeType.asc().nullsLast()).where(sql`(scope_type = 'fleet'::text)`),
		uxCadenceRulesGroup: uniqueIndex("ux_cadence_rules_group").using("btree", table.groupTag.asc().nullsLast()).where(sql`(scope_type = 'group'::text)`),
		uxCadenceRulesVessel: uniqueIndex("ux_cadence_rules_vessel").using("btree", table.vesselId.asc().nullsLast()).where(sql`(scope_type = 'vessel'::text)`),
		cadenceRulesVesselIdFkey: foreignKey({
			columns: [table.vesselId],
			foreignColumns: [vessels.id],
			name: "cadence_rules_vessel_id_fkey"
		}).onDelete("cascade"),
	}
});

export const regulatoryProfileAssignments = pgTable("regulatory_profile_assignments", {
	scopeType: text("scope_type").notNull(),
	vesselId: uuid("vessel_id"),
	groupTag: text("group_tag"),
	profiles: jsonb("profiles").default([]).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
},
(table) => {
	return {
		uxRegProfileAssignmentsFleet: uniqueIndex("ux_reg_profile_assignments_fleet").using("btree", table.scopeType.asc().nullsLast()).where(sql`(scope_type = 'fleet'::text)`),
		uxRegProfileAssignmentsGroup: uniqueIndex("ux_reg_profile_assignments_group").using("btree", table.groupTag.asc().nullsLast()).where(sql`(scope_type = 'group'::text)`),
		uxRegProfileAssignmentsVessel: uniqueIndex("ux_reg_profile_assignments_vessel").using("btree", table.vesselId.asc().nullsLast()).where(sql`(scope_type = 'vessel'::text)`),
		regulatoryProfileAssignmentsVesselIdFkey: foreignKey({
			columns: [table.vesselId],
			foreignColumns: [vessels.id],
			name: "regulatory_profile_assignments_vessel_id_fkey"
		}).onDelete("cascade"),
	}
});

export const users = pgTable("users", {
	id: uuid("id").primaryKey().notNull(),
	username: text("username").notNull(),
	passwordHash: text("password_hash").notNull(),
	roles: jsonb("roles").notNull(),
	mustChangePassword: boolean("must_change_password").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	active: boolean("active").default(true).notNull(),
},
(table) => {
	return {
		usersUsernameKey: unique("users_username_key").on(table.username),
	}
});

export const schemaVersions = pgTable("schema_versions", {
	id: uuid("id").primaryKey().notNull(),
	schemaName: text("schema_name").notNull(),
	version: text("version").notNull(),
	source: text("source").notNull(),
	// Custom bytea parsing
	content: bytea("content").notNull(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }).notNull(),
	publishedBy: text("published_by").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cursor: bigint("cursor", { mode: "number" }).generatedAlwaysAsIdentity({ name: "schema_versions_cursor_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
},
(table) => {
	return {
		idxSchemaVersionsCursor: index("idx_schema_versions_cursor").using("btree", table.cursor.asc().nullsLast()),
		ixSchemaVersionsSchemaName: index("ix_schema_versions_schema_name").using("btree", table.schemaName.asc().nullsLast(), table.publishedAt.desc().nullsFirst()),
		schemaVersionsSchemaNameVersionKey: unique("schema_versions_schema_name_version_key").on(table.schemaName, table.version),
	}
});

export const enrollments = pgTable("enrollments", {
	vesselId: uuid("vessel_id").primaryKey().notNull(),
	state: text("state").notNull(),
	codeHash: text("code_hash").default('').notNull(),
	initialMasterUsername: text("initial_master_username").notNull(),
	initialMasterPasswordHash: text("initial_master_password_hash").notNull(),
	issuedAt: timestamp("issued_at", { withTimezone: true, mode: 'string' }).notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	drPublicKey: text("dr_public_key"),
},
(table) => {
	return {
		enrollmentsVesselIdFkey: foreignKey({
			columns: [table.vesselId],
			foreignColumns: [vessels.id],
			name: "enrollments_vessel_id_fkey"
		}).onDelete("cascade"),
	}
});

export const ruleSeverityAssignments = pgTable("rule_severity_assignments", {
	scopeType: text("scope_type").notNull(),
	vesselId: uuid("vessel_id"),
	groupTag: text("group_tag"),
	severities: jsonb("severities").default({}).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
},
(table) => {
	return {
		uxRuleSevAssignmentsFleet: uniqueIndex("ux_rule_sev_assignments_fleet").using("btree", table.scopeType.asc().nullsLast()).where(sql`(scope_type = 'fleet'::text)`),
		uxRuleSevAssignmentsGroup: uniqueIndex("ux_rule_sev_assignments_group").using("btree", table.groupTag.asc().nullsLast()).where(sql`(scope_type = 'group'::text)`),
		uxRuleSevAssignmentsVessel: uniqueIndex("ux_rule_sev_assignments_vessel").using("btree", table.vesselId.asc().nullsLast()).where(sql`(scope_type = 'vessel'::text)`),
		ruleSeverityAssignmentsVesselIdFkey: foreignKey({
			columns: [table.vesselId],
			foreignColumns: [vessels.id],
			name: "rule_severity_assignments_vessel_id_fkey"
		}).onDelete("cascade"),
	}
});

export const configBundles = pgTable("config_bundles", {
	id: uuid("id").primaryKey().notNull(),
	label: text("label").default('').notNull(),
	schemaVersions: jsonb("schema_versions").default([]).notNull(),
	fieldPolicies: jsonb("field_policies").default([]).notNull(),
	regulatoryProfiles: jsonb("regulatory_profiles").default([]).notNull(),
	cadenceRules: jsonb("cadence_rules").default([]).notNull(),
	ruleSeverities: jsonb("rule_severities").default([]).notNull(),
	defaultRoleNames: jsonb("default_role_names").default([]).notNull(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }).notNull(),
	publishedBy: text("published_by").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cursor: bigint("cursor", { mode: "number" }).generatedAlwaysAsIdentity({ name: "config_bundles_cursor_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
},
(table) => {
	return {
		idxConfigBundlesCursor: index("idx_config_bundles_cursor").using("btree", table.cursor.asc().nullsLast()),
		ixConfigBundlesPublishedAt: index("ix_config_bundles_published_at").using("btree", table.publishedAt.desc().nullsFirst()),
	}
});

export const bundleAssignments = pgTable("bundle_assignments", {
	scopeType: text("scope_type").notNull(),
	vesselId: uuid("vessel_id"),
	groupTag: text("group_tag"),
	bundleId: uuid("bundle_id").notNull(),
	assignedAt: timestamp("assigned_at", { withTimezone: true, mode: 'string' }).notNull(),
},
(table) => {
	return {
		uxBundleAssignmentsFleet: uniqueIndex("ux_bundle_assignments_fleet").using("btree", table.scopeType.asc().nullsLast()).where(sql`(scope_type = 'fleet'::text)`),
		uxBundleAssignmentsGroup: uniqueIndex("ux_bundle_assignments_group").using("btree", table.groupTag.asc().nullsLast()).where(sql`(scope_type = 'group'::text)`),
		uxBundleAssignmentsVessel: uniqueIndex("ux_bundle_assignments_vessel").using("btree", table.vesselId.asc().nullsLast()).where(sql`(scope_type = 'vessel'::text)`),
		bundleAssignmentsVesselIdFkey: foreignKey({
			columns: [table.vesselId],
			foreignColumns: [vessels.id],
			name: "bundle_assignments_vessel_id_fkey"
		}).onDelete("cascade"),
		bundleAssignmentsBundleIdFkey: foreignKey({
			columns: [table.bundleId],
			foreignColumns: [configBundles.id],
			name: "bundle_assignments_bundle_id_fkey"
		}),
	}
});

export const vesselCredentials = pgTable("vessel_credentials", {
	vesselId: uuid("vessel_id").primaryKey().notNull(),
	tokenHash: text("token_hash").notNull(),
	tokenLookupHash: text("token_lookup_hash").notNull(),
	issuedAt: timestamp("issued_at", { withTimezone: true, mode: 'string' }).notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: 'string' }),
},
(table) => {
	return {
		uxVesselCredentialsLookupHash: uniqueIndex("ux_vessel_credentials_lookup_hash").using("btree", table.tokenLookupHash.asc().nullsLast()),
		vesselCredentialsVesselIdFkey: foreignKey({
			columns: [table.vesselId],
			foreignColumns: [vessels.id],
			name: "vessel_credentials_vessel_id_fkey"
		}).onDelete("cascade"),
	}
});

export const vesselSyncStatus = pgTable("vessel_sync_status", {
	vesselId: uuid("vessel_id").primaryKey().notNull(),
	appVersion: text("app_version").default('').notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).notNull(),
	appliedBundleId: text("applied_bundle_id").default('').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	appliedBundleVersion: bigint("applied_bundle_version", { mode: "number" }).default(0).notNull(),
},
(table) => {
	return {
		vesselSyncStatusVesselIdFkey: foreignKey({
			columns: [table.vesselId],
			foreignColumns: [vessels.id],
			name: "vessel_sync_status_vessel_id_fkey"
		}).onDelete("cascade"),
	}
});

export const reportAuditEvents = pgTable("report_audit_events", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "report_audit_events_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	vesselId: uuid("vessel_id").notNull(),
	reportId: text("report_id").notNull(),
	versionNo: integer("version_no").notNull(),
	eventType: text("event_type").notNull(),
	actor: text("actor").default('').notNull(),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).notNull(),
	detail: jsonb("detail").default({}).notNull(),
	receivedAt: timestamp("received_at", { withTimezone: true, mode: 'string' }).notNull(),
	origin: text("origin").default('vessel').notNull(),
},
(table) => {
	return {
		idxReportAuditEventsReport: index("idx_report_audit_events_report").using("btree", table.vesselId.asc().nullsLast(), table.reportId.asc().nullsLast(), table.occurredAt.asc().nullsLast()),
		reportAuditEventsVesselIdFkey: foreignKey({
			columns: [table.vesselId],
			foreignColumns: [vessels.id],
			name: "report_audit_events_vessel_id_fkey"
		}).onDelete("cascade"),
	}
});

export const invalidationNotices = pgTable("invalidation_notices", {
	seq: bigserial("seq", { mode: "bigint" }).primaryKey().notNull(),
	vesselId: uuid("vessel_id").notNull(),
	reportId: text("report_id").notNull(),
	versionNo: integer("version_no").notNull(),
	brokenRules: jsonb("broken_rules").notNull(),
	computedAt: timestamp("computed_at", { withTimezone: true, mode: 'string' }).notNull(),
},
(table) => {
	return {
		idxInvalidationNoticesVesselSeq: index("idx_invalidation_notices_vessel_seq").using("btree", table.vesselId.asc().nullsLast(), table.seq.asc().nullsLast()),
		invalidationNoticesVesselIdFkey: foreignKey({
			columns: [table.vesselId],
			foreignColumns: [vessels.id],
			name: "invalidation_notices_vessel_id_fkey"
		}).onDelete("cascade"),
	}
});

export const attachmentUploads = pgTable("attachment_uploads", {
	contentHash: text("content_hash").primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalSize: bigint("total_size", { mode: "number" }).notNull(),
	chunkSize: integer("chunk_size").notNull(),
	contentType: text("content_type").default('').notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).notNull(),
});

export const chatMessages = pgTable("chat_messages", {
	id: text("id").primaryKey().notNull(),
	vesselId: uuid("vessel_id").notNull(),
	reportId: text("report_id").notNull(),
	sender: text("sender").notNull(),
	body: text("body").notNull(),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }).notNull(),
	direction: text("direction").notNull(),
	seq: bigserial("seq", { mode: "bigint" }).notNull(),
},
(table) => {
	return {
		idxChatMessagesReport: index("idx_chat_messages_report").using("btree", table.vesselId.asc().nullsLast(), table.reportId.asc().nullsLast(), table.sentAt.asc().nullsLast()),
		idxChatMessagesVesselSeq: index("idx_chat_messages_vessel_seq").using("btree", table.vesselId.asc().nullsLast(), table.seq.asc().nullsLast()),
		chatMessagesVesselIdFkey: foreignKey({
			columns: [table.vesselId],
			foreignColumns: [vessels.id],
			name: "chat_messages_vessel_id_fkey"
		}).onDelete("cascade"),
	}
});

export const remarks = pgTable("remarks", {
	id: text("id").primaryKey().notNull(),
	remarkSetId: text("remark_set_id").notNull(),
	vesselId: uuid("vessel_id").notNull(),
	reportId: text("report_id").notNull(),
	versionNo: integer("version_no").notNull(),
	fieldName: text("field_name").notNull(),
	body: text("body").notNull(),
	author: text("author").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	resolved: boolean("resolved").default(false).notNull(),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	seq: bigserial("seq", { mode: "bigint" }).notNull(),
},
(table) => {
	return {
		idxRemarksReport: index("idx_remarks_report").using("btree", table.vesselId.asc().nullsLast(), table.reportId.asc().nullsLast()),
		idxRemarksVesselSeq: index("idx_remarks_vessel_seq").using("btree", table.vesselId.asc().nullsLast(), table.seq.asc().nullsLast()),
		remarksVesselIdFkey: foreignKey({
			columns: [table.vesselId],
			foreignColumns: [vessels.id],
			name: "remarks_vessel_id_fkey"
		}).onDelete("cascade"),
	}
});

export const reportAttachments = pgTable("report_attachments", {
	id: text("id").primaryKey().notNull(),
	vesselId: uuid("vessel_id").notNull(),
	reportId: text("report_id").notNull(),
	versionNo: integer("version_no").notNull(),
	fieldName: text("field_name").notNull(),
	filename: text("filename").notNull(),
	contentType: text("content_type").notNull(),
	contentHash: text("content_hash").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
	receivedAt: timestamp("received_at", { withTimezone: true, mode: 'string' }).notNull(),
},
(table) => {
	return {
		idxReportAttachmentsReport: index("idx_report_attachments_report").using("btree", table.vesselId.asc().nullsLast(), table.reportId.asc().nullsLast(), table.versionNo.asc().nullsLast()),
		reportAttachmentsVesselIdFkey: foreignKey({
			columns: [table.vesselId],
			foreignColumns: [vessels.id],
			name: "report_attachments_vessel_id_fkey"
		}).onDelete("cascade"),
		reportAttachmentsVesselIdReportIdVersionNoContentHKey: unique("report_attachments_vessel_id_report_id_version_no_content_h_key").on(table.vesselId, table.reportId, table.versionNo, table.contentHash),
	}
});

export const fieldPolicyAssignments = pgTable("field_policy_assignments", {
	scopeType: text("scope_type").notNull(),
	vesselId: uuid("vessel_id"),
	groupTag: text("group_tag"),
	schemaName: text("schema_name").notNull(),
	schemaVersion: text("schema_version").notNull(),
	policy: jsonb("policy").default({}).notNull(),
	prefill: jsonb("prefill").default({}).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	events: jsonb("events").default({}).notNull(),
},
(table) => {
	return {
		uxFieldPolicyAssignmentsFleet: uniqueIndex("ux_field_policy_assignments_fleet").using("btree", table.schemaName.asc().nullsLast(), table.schemaVersion.asc().nullsLast()).where(sql`(scope_type = 'fleet'::text)`),
		uxFieldPolicyAssignmentsGroup: uniqueIndex("ux_field_policy_assignments_group").using("btree", table.schemaName.asc().nullsLast(), table.schemaVersion.asc().nullsLast(), table.groupTag.asc().nullsLast()).where(sql`(scope_type = 'group'::text)`),
		uxFieldPolicyAssignmentsVessel: uniqueIndex("ux_field_policy_assignments_vessel").using("btree", table.schemaName.asc().nullsLast(), table.schemaVersion.asc().nullsLast(), table.vesselId.asc().nullsLast()).where(sql`(scope_type = 'vessel'::text)`),
		fieldPolicyAssignmentsVesselIdFkey: foreignKey({
			columns: [table.vesselId],
			foreignColumns: [vessels.id],
			name: "field_policy_assignments_vessel_id_fkey"
		}).onDelete("cascade"),
	}
});

export const restoreCommands = pgTable("restore_commands", {
	id: text("id").primaryKey().notNull(),
	vesselId: uuid("vessel_id").notNull(),
	reason: text("reason").notNull(),
	issuedBy: text("issued_by").notNull(),
	issuedAt: timestamp("issued_at", { withTimezone: true, mode: 'string' }).notNull(),
	fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: 'string' }),
	appliedAt: timestamp("applied_at", { withTimezone: true, mode: 'string' }),
	seq: bigserial("seq", { mode: "bigint" }).notNull(),
},
(table) => {
	return {
		idxRestoreCommandsVesselSeq: index("idx_restore_commands_vessel_seq").using("btree", table.vesselId.asc().nullsLast(), table.seq.asc().nullsLast()),
		restoreCommandsVesselIdFkey: foreignKey({
			columns: [table.vesselId],
			foreignColumns: [vessels.id],
			name: "restore_commands_vessel_id_fkey"
		}).onDelete("cascade"),
	}
});

export const userCommands = pgTable("user_commands", {
	id: text("id").primaryKey().notNull(),
	vesselId: uuid("vessel_id").notNull(),
	action: text("action").notNull(),
	username: text("username").notNull(),
	role: text("role").default('').notNull(),
	temporaryPassword: text("temporary_password").default('').notNull(),
	canSubmit: boolean("can_submit").default(false).notNull(),
	active: boolean("active").default(false).notNull(),
	issuedBy: text("issued_by").notNull(),
	issuedAt: timestamp("issued_at", { withTimezone: true, mode: 'string' }).notNull(),
	fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: 'string' }),
	appliedAt: timestamp("applied_at", { withTimezone: true, mode: 'string' }),
	seq: bigserial("seq", { mode: "bigint" }).notNull(),
},
(table) => {
	return {
		idxUserCommandsVesselSeq: index("idx_user_commands_vessel_seq").using("btree", table.vesselId.asc().nullsLast(), table.seq.asc().nullsLast()),
		userCommandsVesselIdFkey: foreignKey({
			columns: [table.vesselId],
			foreignColumns: [vessels.id],
			name: "user_commands_vessel_id_fkey"
		}).onDelete("cascade"),
	}
});

export const apiKeys = pgTable("api_keys", {
	id: uuid("id").primaryKey().notNull(),
	label: text("label").notNull(),
	tokenHash: text("token_hash").notNull(),
	tokenLookupHash: text("token_lookup_hash").notNull(),
	groupId: text("group_id"),
	createdBy: text("created_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: 'string' }),
},
(table) => {
	return {
		uxApiKeysLookupHash: uniqueIndex("ux_api_keys_lookup_hash").using("btree", table.tokenLookupHash.asc().nullsLast()),
	}
});

export const apiKeyEvents = pgTable("api_key_events", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "api_key_events_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	apiKeyId: uuid("api_key_id").notNull(),
	kind: text("kind").notNull(),
	at: timestamp("at", { withTimezone: true, mode: 'string' }).notNull(),
},
(table) => {
	return {
		ixApiKeyEventsApiKeyId: index("ix_api_key_events_api_key_id").using("btree", table.apiKeyId.asc().nullsLast(), table.at.desc().nullsFirst()),
		apiKeyEventsApiKeyIdFkey: foreignKey({
			columns: [table.apiKeyId],
			foreignColumns: [apiKeys.id],
			name: "api_key_events_api_key_id_fkey"
		}).onDelete("cascade"),
	}
});

export const attachmentUploadChunks = pgTable("attachment_upload_chunks", {
	contentHash: text("content_hash").notNull(),
	chunkIndex: integer("chunk_index").notNull(),
	receivedAt: timestamp("received_at", { withTimezone: true, mode: 'string' }).notNull(),
},
(table) => {
	return {
		attachmentUploadChunksContentHashFkey: foreignKey({
			columns: [table.contentHash],
			foreignColumns: [attachmentUploads.contentHash],
			name: "attachment_upload_chunks_content_hash_fkey"
		}).onDelete("cascade"),
		attachmentUploadChunksPkey: primaryKey({ columns: [table.contentHash, table.chunkIndex], name: "attachment_upload_chunks_pkey"}),
	}
});

export const notificationReadState = pgTable("notification_read_state", {
	userId: uuid("user_id").notNull(),
	notificationId: text("notification_id").notNull(),
	readAt: timestamp("read_at", { withTimezone: true, mode: 'string' }).notNull(),
},
(table) => {
	return {
		notificationReadStateUserIdFkey: foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "notification_read_state_user_id_fkey"
		}).onDelete("cascade"),
		notificationReadStatePkey: primaryKey({ columns: [table.userId, table.notificationId], name: "notification_read_state_pkey"}),
	}
});

export const outboxReceipts = pgTable("outbox_receipts", {
	vesselId: uuid("vessel_id").notNull(),
	itemId: text("item_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sequenceNo: bigint("sequence_no", { mode: "number" }).notNull(),
	receivedAt: timestamp("received_at", { withTimezone: true, mode: 'string' }).notNull(),
},
(table) => {
	return {
		idxOutboxReceiptsVesselSequence: index("idx_outbox_receipts_vessel_sequence").using("btree", table.vesselId.asc().nullsLast(), table.sequenceNo.asc().nullsLast()),
		outboxReceiptsVesselIdFkey: foreignKey({
			columns: [table.vesselId],
			foreignColumns: [vessels.id],
			name: "outbox_receipts_vessel_id_fkey"
		}).onDelete("cascade"),
		outboxReceiptsPkey: primaryKey({ columns: [table.vesselId, table.itemId], name: "outbox_receipts_pkey"}),
	}
});

export const reportReviews = pgTable("report_reviews", {
	vesselId: uuid("vessel_id").notNull(),
	reportId: text("report_id").notNull(),
	reviewedBy: text("reviewed_by").notNull(),
	reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: 'string' }).notNull(),
},
(table) => {
	return {
		reportReviewsVesselIdFkey: foreignKey({
			columns: [table.vesselId],
			foreignColumns: [vessels.id],
			name: "report_reviews_vessel_id_fkey"
		}).onDelete("cascade"),
		reportReviewsPkey: primaryKey({ columns: [table.vesselId, table.reportId], name: "report_reviews_pkey"}),
	}
});

export const vesselUsers = pgTable("vessel_users", {
	vesselId: uuid("vessel_id").notNull(),
	username: text("username").notNull(),
	role: text("role").notNull(),
	active: boolean("active").notNull(),
	canSubmit: boolean("can_submit").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	reportedAt: timestamp("reported_at", { withTimezone: true, mode: 'string' }).notNull(),
},
(table) => {
	return {
		vesselUsersVesselIdFkey: foreignKey({
			columns: [table.vesselId],
			foreignColumns: [vessels.id],
			name: "vessel_users_vessel_id_fkey"
		}).onDelete("cascade"),
		vesselUsersPkey: primaryKey({ columns: [table.vesselId, table.username], name: "vessel_users_pkey"}),
	}
});

export const reportVersions = pgTable("report_versions", {
	vesselId: uuid("vessel_id").notNull(),
	reportId: text("report_id").notNull(),
	versionNo: integer("version_no").notNull(),
	schemaKind: text("schema_kind").notNull(),
	schemaVersion: text("schema_version").default('').notNull(),
	eventType: text("event_type").notNull(),
	state: text("state").notNull(),
	eventTime: timestamp("event_time", { withTimezone: true, mode: 'string' }).notNull(),
	fields: jsonb("fields").notNull(),
	submittedAt: timestamp("submitted_at", { withTimezone: true, mode: 'string' }),
	receivedAt: timestamp("received_at", { withTimezone: true, mode: 'string' }).notNull(),
},
(table) => {
	return {
		idxReportVersionsVessel: index("idx_report_versions_vessel").using("btree", table.vesselId.asc().nullsLast()),
		reportVersionsVesselIdFkey: foreignKey({
			columns: [table.vesselId],
			foreignColumns: [vessels.id],
			name: "report_versions_vessel_id_fkey"
		}).onDelete("cascade"),
		reportVersionsPkey: primaryKey({ columns: [table.vesselId, table.reportId, table.versionNo], name: "report_versions_pkey"}),
	}
});