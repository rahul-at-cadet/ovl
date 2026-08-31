import {
  DynamicModule,
  Global,
  Logger,
  MiddlewareConsumer,
  Module,
  NestModule,
  OnApplicationShutdown,
  Inject,
  Optional,
} from '@nestjs/common';
import { Pool } from 'pg';
import { UsersModule } from '../users/users.module';
import { createPool, createPlatformDb } from '@ovl/database';
import {
  ADMIN_PG_POOL,
  PG_POOL,
  PLATFORM_DB,
  TENANCY_OPTIONS,
  resolveTenancyOptions,
  type TenancyModuleOptions,
} from './tenancy.constants';
import { TenantMiddleware } from './tenant.middleware';
import { TenantGuard } from './tenant.guard';
import { TenantRegistryService } from './tenant-registry.service';
import { TenantMembershipService } from './tenant-membership.service';
import { TenantSettingsService } from './tenant-settings.service';
import { PlatformFleetService } from './platform-fleet.service';
import { TenantDbService } from './tenant-db.service';
import { TenantCacheService } from './tenant-cache.service';
import { TenantConcurrencyService } from './tenant-concurrency.service';
import { TenantSelectionService } from './tenant-selection.service';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { PlatformDbService } from './platform-db.service';
import { SuperAdminService } from './super-admin.service';
import { TenantMigrationRunnerService } from './tenant-migration-runner.service';
import { EdgeTenantResolverService } from './edge-tenant-resolver.service';

/**
 * Schema-per-tenant data access for the office API.
 *
 * Register it with `TenancyModule.forRoot(...)` in AppModule, *after*
 * AuthModule. Order matters: Nest applies middleware in module-registration
 * order, and TenantMiddleware reads the SuperTokens session that AuthModule
 * sets up. Registered before it, every request would resolve to no tenant.
 *
 * @Global because tenant-scoped data access is cross-cutting — near enough
 * every feature module needs TenantDbService, and re-importing this one
 * everywhere would add noise without adding safety. It mirrors how
 * DatabaseModule and AuthModule are already registered in this codebase.
 *
 * The tRPC router is mounted outside Nest's middleware chain, via a bare
 * `app.use()` in main.ts, so it does not pick this middleware up
 * automatically. See main.ts, where TenantMiddleware is fetched from the
 * container and mounted ahead of the tRPC handler.
 */
@Global()
@Module({})
export class TenancyModule implements NestModule, OnApplicationShutdown {
  private static readonly logger = new Logger(TenancyModule.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Optional() @Inject(ADMIN_PG_POOL) private readonly adminPool: Pool | null,
  ) {}

  static forRoot(options: TenancyModuleOptions): DynamicModule {
    const resolved = resolveTenancyOptions(options);

    return {
      module: TenancyModule,
      // UsersModule provides UsersService, which provisioning uses to create a
      // tenant's first admin.
      imports: [UsersModule],
      providers: [
        { provide: TENANCY_OPTIONS, useValue: resolved },
        {
          provide: PG_POOL,
          useFactory: () =>
            createPool({
              connectionString: resolved.connectionString,
              max: resolved.poolMax,
              connectionTimeoutMillis: resolved.connectionTimeoutMillis,
              applicationName: 'ovl-api-office',
            }),
        },
        {
          provide: PLATFORM_DB,
          useFactory: (pool: Pool) => createPlatformDb(pool),
          inject: [PG_POOL],
        },
        {
          // Null rather than absent when unconfigured, so
          // TenantProvisioningService can report "disabled" instead of Nest
          // failing to resolve a dependency at boot.
          provide: ADMIN_PG_POOL,
          useFactory: () => {
            if (!resolved.adminConnectionString) {
              TenancyModule.logger.log(
                'No admin connection string configured; tenant provisioning is disabled in this process.',
              );
              return null;
            }
            return createPool({
              connectionString: resolved.adminConnectionString,
              // Provisioning is rare, serial and long-running. A big pool here
              // would just hold administrative connections open for nothing.
              max: 2,
              applicationName: 'ovl-api-office-admin',
            });
          },
        },
        TenantConcurrencyService,
        TenantRegistryService,
        TenantMembershipService,
        TenantSettingsService,
        PlatformFleetService,
        TenantDbService,
        TenantCacheService,
        TenantProvisioningService,
        TenantSelectionService,
        PlatformDbService,
        SuperAdminService,
        TenantMigrationRunnerService,
        EdgeTenantResolverService,
        TenantMiddleware,
        TenantGuard,
      ],
      exports: [
        PG_POOL,
        PLATFORM_DB,
        TENANCY_OPTIONS,
        TenantConcurrencyService,
        TenantRegistryService,
        TenantMembershipService,
        TenantSettingsService,
        PlatformFleetService,
        TenantDbService,
        TenantCacheService,
        TenantProvisioningService,
        TenantSelectionService,
        PlatformDbService,
        SuperAdminService,
        TenantMigrationRunnerService,
        EdgeTenantResolverService,
        TenantMiddleware,
        TenantGuard,
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(TenantMiddleware)
      // SuperTokens owns these routes end to end and answers before any
      // tenant exists to resolve — running tenant resolution on them would
      // cost a lookup per sign-in attempt and buy nothing.
      .exclude('auth/(.*)', 'health')
      .forRoutes('*');
  }

  async onApplicationShutdown(): Promise<void> {
    // Both pools, not just the serving one. Without this, `nest start --watch`
    // and every integration-test run leak a pool per reload until the machine
    // runs out of Postgres connections — and the admin pool is the easier one
    // to forget, because it is usually absent.
    await Promise.all([
      this.pool.end().catch(() => undefined),
      this.adminPool?.end().catch(() => undefined),
    ]);
  }
}
