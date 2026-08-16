import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './packages/vessel-database/src/schema';

const sqlite = new Database('./apps/api-vessel/vessel.sqlite');
const db = drizzle(sqlite, { schema });

async function run() {
  const reports = await db.query.reports.findMany();
  console.log(reports);
}
run();
