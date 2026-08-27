export * from './schema.js';
export * from './relations.js';
export * from './db.js';
export * from './pool.js';
export * from './platform-schema.js';
// Also exposed as a namespace so it can be handed to drizzle's `{ schema }`
// option wholesale: `drizzle(pool, { schema: platformSchema })`.
export * as platformSchema from './platform-schema.js';
export * from 'drizzle-orm';
