import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as schema from '@ovl/vessel-database';

export const DATABASE_CONNECTION = 'DATABASE_CONNECTION';

const logger = new Logger('DatabaseModule');

function migrationsFolder(): string {
  // Resolved via the package rather than a relative path, so this does
  // not depend on the process's cwd.
  return path.join(path.dirname(require.resolve('@ovl/vessel-database/package.json')), 'drizzle');
}

/**
 * Owns the SQLite handle so it can be replaced at runtime.
 *
 * Restoring a snapshot means putting a different file where the live
 * database is, and SQLite cannot have the old handle open while that
 * happens. The Go original closes its store, swaps the files, reopens and
 * assigns the new store back over the old pointer, all under a write lock
 * (vessel/httpapi.restoreFromSnapshot). Nest hands every service a
 * singleton at construction time, so there is no pointer to reassign —
 * hence the proxy below, which is this port's equivalent of that
 * reassignment.
 */
@Injectable()
export class VesselDatabase {
  private instance: BetterSQLite3Database<typeof schema>;
  private connection: Database.Database;

  constructor(readonly filePath: string) {
    this.connection = new Database(filePath);
    this.instance = drizzle(this.connection, { schema });
    // Nothing else in this app ever ran drizzle-kit's migrator on
    // startup — schema.ts had picked up new tables (chat_messages) that
    // were never actually applied to a real vessel.sqlite, leaving the
    // feature dead despite complete application code.
    migrate(this.instance, { migrationsFolder: migrationsFolder() });
    logger.log(`Applied vessel-database migrations from ${migrationsFolder()}.`);
  }

  /** Where the database file lives — the root for backups and attachments. */
  get dataDir(): string {
    return path.dirname(path.resolve(this.filePath));
  }

  get current(): BetterSQLite3Database<typeof schema> {
    return this.instance;
  }

  /** Closes the handle so the file underneath can be replaced. */
  close(): void {
    this.connection.close();
  }

  /**
   * Reopens against whatever now sits at filePath, and re-runs migrations
   * — a snapshot taken before a schema change would otherwise come back
   * missing tables the running build expects.
   */
  reopen(): void {
    this.connection = new Database(this.filePath);
    this.instance = drizzle(this.connection, { schema });
    migrate(this.instance, { migrationsFolder: migrationsFolder() });
    logger.log('Reopened the vessel database.');
  }

  /** Raw handle, for the VACUUM INTO a snapshot needs. */
  get raw(): Database.Database {
    return this.connection;
  }
}

@Global()
@Module({
  providers: [
    {
      provide: VesselDatabase,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        new VesselDatabase(configService.get<string>('LOCAL_DB_PATH', 'vessel.sqlite')),
    },
    {
      provide: DATABASE_CONNECTION,
      inject: [VesselDatabase],
      // A proxy, not the drizzle instance itself: every service holds
      // this reference for the lifetime of the process, so a restore that
      // swapped the underlying handle would otherwise leave all of them
      // pointing at a closed database.
      useFactory: (holder: VesselDatabase) =>
        new Proxy({} as BetterSQLite3Database<typeof schema>, {
          get: (_target, prop, receiver) => Reflect.get(holder.current as object, prop, receiver),
          has: (_target, prop) => prop in (holder.current as object),
        }),
    },
  ],
  exports: [DATABASE_CONNECTION, VesselDatabase],
})
export class DatabaseModule {}
