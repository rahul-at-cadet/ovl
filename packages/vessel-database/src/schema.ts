import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

export const syncOutbox = sqliteTable('sync_outbox', {
  id: text('id').primaryKey(), // uuid
  eventType: text('event_type').notNull(),
  payload: text('payload').notNull(), // JSON string
  createdAt: text('created_at').notNull(), // ISO string
  processedAt: text('processed_at'), // null if not yet pushed to shore
});

// Users table for local edge node authentication (offline-first)
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull(),
  canSubmit: integer('can_submit', { mode: 'boolean' }).notNull().default(false),
  mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull().default(true),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Basic key-value configuration store that syncs from shore
export const configStore = sqliteTable('config_store', {
  key: text('key').primaryKey(),
  value: text('value').notNull(), // JSON string
  updatedAt: text('updated_at').notNull(), // Cursor for downstream sync
});

export const reports = sqliteTable('reports', {
  reportId: text('report_id').notNull(),
  versionNo: integer('version_no').notNull(),
  schemaName: text('schema_name').notNull(),
  eventType: text('event_type').notNull(),
  eventTime: text('event_time').notNull(), // RFC3339, UTC
  fields: text('fields', { mode: 'json' }).notNull(), // JSON
  state: text('state').notNull(), // draft, ready, submitted, invalidated
  invalidatedFrom: text('invalidated_from').notNull().default(''),
  invalidatedRules: text('invalidated_rules', { mode: 'json' }).notNull().default([]),
  createdAt: text('created_at').notNull(),
  createdBy: text('created_by').notNull(),
  updatedAt: text('updated_at').notNull(),
  submittedAt: text('submitted_at'),
  submittedBy: text('submitted_by').notNull().default(''),
}, (table) => ({
  pk: primaryKey({ columns: [table.reportId, table.versionNo] }),
}));

export const reportEvents = sqliteTable('report_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  reportId: text('report_id').notNull(),
  versionNo: integer('version_no').notNull(),
  type: text('type').notNull(),
  at: text('at').notNull(), // RFC3339, UTC
  actor: text('actor').notNull().default(''),
  detail: text('detail', { mode: 'json' }).notNull().default({}),
});

export const chatMessages = sqliteTable('chat_messages', {
  id: text('id').primaryKey(),
  reportId: text('report_id').notNull(),
  sender: text('sender').notNull(),
  body: text('body').notNull(),
  sentAt: text('sent_at').notNull(), // ISO string
  direction: text('direction').notNull(), // 'shore_to_ship' or 'ship_to_shore'
});
