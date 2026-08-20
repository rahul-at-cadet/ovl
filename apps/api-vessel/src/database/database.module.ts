import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as schema from '@ovl/vessel-database';

export const DATABASE_CONNECTION = 'DATABASE_CONNECTION';

const logger = new Logger('DatabaseModule');

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_CONNECTION,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const dbPath = configService.get<string>(
          'LOCAL_DB_PATH',
          'vessel.sqlite',
        );
        const sqlite = new Database(dbPath);
        const db = drizzle(sqlite, { schema });

        // Nothing else in this app ever ran drizzle-kit's migrator on
        // startup — schema.ts had picked up new tables (chat_messages)
        // that were never actually applied to a real vessel.sqlite,
        // leaving the feature dead despite complete application code.
        // Resolved via the package's own path rather than a relative
        // one, so this doesn't depend on the process's cwd.
        const migrationsFolder = path.join(
          path.dirname(require.resolve('@ovl/vessel-database/package.json')),
          'drizzle',
        );
        migrate(db, { migrationsFolder });
        logger.log(`Applied vessel-database migrations from ${migrationsFolder}.`);

        return db;
      },
    },
  ],
  exports: [DATABASE_CONNECTION],
})
export class DatabaseModule {}
