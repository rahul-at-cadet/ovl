import { defineConfig } from 'drizzle-kit';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load root .env first (highest priority), then package-local .env as fallback
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config(); // package-level .env (won't override already-set vars)


export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
