import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';

const sqlite = new Database('../../apps/api-vessel/vessel.sqlite');
const db = drizzle(sqlite);

migrate(db, { migrationsFolder: './drizzle' });
console.log('Migrations applied successfully!');
sqlite.close();
