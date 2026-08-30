import { Injectable, Inject, Optional } from '@nestjs/common';
import { tryCurrentTenant } from '../tenancy/tenant-context';
import { TenantDbService } from '../tenancy/tenant-db.service';

/** Whether tenant schemas are in play; see the signup override below. */
const multiTenancyEnabled = process.env.MULTI_TENANCY_ENABLED === 'true';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import supertokens from 'supertokens-node';
import Session from 'supertokens-node/recipe/session';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import { eq } from 'drizzle-orm';
import * as schema from '@ovl/database';
import * as argon2 from 'argon2';

export const ConfigInjectionToken = 'ConfigInjectionToken';
export const DB_CONNECTION = 'DATABASE_CONNECTION'; // maps to @Global DatabaseModule

export interface AuthModuleConfig {
  appInfo: {
    appName: string;
    apiDomain: string;
    websiteDomain: string;
    apiBasePath: string;
    websiteBasePath: string;
  };
  connectionURI: string;
  apiKey?: string;
}

export type LocalUser = typeof schema.users.$inferSelect;

@Injectable()
export class SupertokensService {
  private db: NodePgDatabase<typeof schema>;

  constructor(
    @Inject(ConfigInjectionToken) private config: AuthModuleConfig,
    @Inject('DATABASE_CONNECTION') db: NodePgDatabase<typeof schema>,
    @Optional() @Inject(TenantDbService) private readonly tenantDb?: TenantDbService,
  ) {
    this.db = db;

    supertokens.init({
      appInfo: config.appInfo,
      supertokens: {
        connectionURI: config.connectionURI,
        apiKey: config.apiKey,
      },
      recipeList: [
        EmailPassword.init({
          override: {
            apis: (originalImplementation) => ({
              ...originalImplementation,

              // Intercept the signUp API to provision a local Postgres user.
              // NOTE: SuperTokens already creates a session automatically
              // after signup — we just need to insert the local user record.
              signUpPOST: async (input) => {
                const response = await originalImplementation.signUpPOST!(input);

                // Under multi-tenancy a fresh signup belongs to no tenant, so
                // there is no schema to write a profile into. Accounts are
                // created deliberately instead: a super admin creates a
                // tenant's first admin when the tenant is registered, and that
                // admin creates the rest. Self-signup still establishes the
                // SuperTokens identity; it simply no longer conjures a profile
                // that would have to live somewhere arbitrary.
                if (response.status === 'OK' && !multiTenancyEnabled) {
                  const email = response.user.emails[0];

                  const passwordHash = await argon2.hash(
                    input.formFields.find((f) => f.id === 'password')!.value as string,
                    { type: argon2.argon2id },
                  );

                  await db.insert(schema.users).values({
                    username: email,
                    passwordHash,
                    roles: ['viewer'] as unknown as string,
                    mustChangePassword: false,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    active: true,
                  }).onConflictDoNothing();
                }

                return response;
              },
            }),
          },
        }),
        Session.init({
          cookieSecure: false, // set true in production (HTTPS)
          cookieSameSite: 'lax',
          // Use headers for token transfer so both curl and browser SDKs work.
          // The frontend SuperTokens SDK will automatically send st-access-token
          // as a header on subsequent requests.
          getTokenTransferMethod: () => 'header',
        }),
      ],
    });
  }

  /**
   * Looks up the local Postgres user record using the SuperTokens userId
   * stored in the session's access token payload.
   */
  /**
   * The SuperTokens identity itself, with no tenant lookup.
   *
   * Needed for the one caller that has no tenant to look in: a platform super
   * admin, whose profile cannot live in a tenant schema because they belong to
   * no tenant.
   */
  async getSupertokensUser(stUserId: string) {
    return supertokens.getUser(stUserId);
  }

  async getLocalUser(stUserId: string): Promise<LocalUser | null> {
    // The SuperTokens userId maps to the email, which is the username in our DB
    const stUser = await supertokens.getUser(stUserId);
    if (!stUser) return null;

    const email = stUser.emails[0];
    // Tenant-scoped: a local profile lives in its tenant's schema, and this is
    // called from inside a request that already has that tenant on its context.
    // Returns null outside one rather than throwing, because AuthGuard treats
    // "no local user" as an ordinary unauthenticated case.
    // Both conditions are the same statement in practice — no tenant context
    // means no tenant stack — but each is checked because either alone leaves
    // a null dereference.
    if (!this.tenantDb || !tryCurrentTenant()) return null;

    const results = await this.tenantDb.withTenant(
      (db) =>
        db.select().from(schema.users).where(eq(schema.users.username, email)).limit(1),
      { readOnly: true },
    );

    return results[0] ?? null;
  }
}
