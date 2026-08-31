import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { TrpcModule } from './rpc/trpc.module';
import { ReportsModule } from './reports/reports.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { FormCatalogueModule } from './form-catalogue/form-catalogue.module';
import { AuditModule } from './audit/audit.module';

/**
 * Multi-tenancy is opt-in while the migration from the single shared schema is
 * in progress. With MULTI_TENANCY_ENABLED unset the app behaves exactly as it
 * did before — same global DATABASE_CONNECTION, same everything — so the
 * tenancy code can land, be reviewed and be exercised against a scratch
 * database without any risk to a running deployment.
 *
 * See apps/api-office/src/tenancy/README.md for the cutover sequence.
 */
const multiTenancyEnabled = process.env.MULTI_TENANCY_ENABLED === 'true';

const tenancyImports = multiTenancyEnabled
  ? [
      TenancyModule.forRoot({
        // Deliberately a DIFFERENT role from DATABASE_URL while the migration
        // off the single shared schema is in progress.
        //
        // DATABASE_URL still serves the legacy DATABASE_CONNECTION, which reads
        // `public` and therefore needs a role with access to it. The tenant pool
        // must be `ovl_api`, which has no access to `public` and is NOINHERIT —
        // that is the whole isolation model. Pointing both at one superuser
        // would work and would silently make every `permission denied`
        // guarantee inert, because superusers bypass privilege checks: the
        // tests would pass, the app would behave, and layer 4 would be gone.
        //
        // Falls back to DATABASE_URL so a single-role setup still boots; the
        // fallback is a convenience, not the intended production shape.
        connectionString: process.env.TENANCY_DATABASE_URL ?? requireEnv('DATABASE_URL'),
        adminConnectionString: process.env.ADMIN_DATABASE_URL,
        poolMax: process.env.PG_POOL_MAX ? Number(process.env.PG_POOL_MAX) : undefined,
      }),
      // Depends on PlatformDbService and TenantDbService, so it only makes
      // sense once TenancyModule is registered.
      FormCatalogueModule,
      // Same: it writes platform.audit_events through TenancyModule's pool.
      AuditModule,
    ]
  : [];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is not defined`);
  return value;
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Load root .env first, then app-level .env — root always wins
      // Change DATABASE_URL in the root .env to switch Postgres instances
      envFilePath: [
        '../../.env',          // monorepo root (highest priority)
        '.env',                // app-local fallback
      ],
    }),
    DatabaseModule,
    AuthModule.forRoot({
      connectionURI: process.env.SUPERTOKENS_CONNECTION_URI || 'http://localhost:3567',
      apiKey: process.env.SUPERTOKENS_API_KEY,
      appInfo: {
        appName: 'SPARKS',
        apiDomain: process.env.API_DOMAIN || 'http://localhost:3001',
        websiteDomain: process.env.WEBSITE_DOMAIN || 'http://localhost:3000',
        apiBasePath: '/auth',
        websiteBasePath: '/login',
      },
    }),
    // After AuthModule: Nest applies middleware in module-registration order,
    // and TenantMiddleware reads the session AuthModule establishes.
    ...tenancyImports,
    UsersModule,
    TrpcModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

