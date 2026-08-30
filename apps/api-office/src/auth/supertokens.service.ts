import { Injectable, Inject, Optional } from '@nestjs/common';
import { tryCurrentTenant } from '../tenancy/tenant-context';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { TenantRegistryService } from '../tenancy/tenant-registry.service';
import { AuditService } from '../audit/audit.service';

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


/**
 * The address and user agent behind a SuperTokens API call.
 *
 * SuperTokens wraps the framework's request, so neither is available directly.
 * `getHeaderValue` is part of its public BaseRequest interface; the underlying
 * Express request is not, which is why reaching it is guarded rather than
 * typed — a shape change on their side should cost a null IP, not a failed
 * sign-in.
 */
function requestFacts(input: { options?: { req?: unknown } }): {
  ip: string | null;
  userAgent: string | null;
} {
  const req = input.options?.req as
    | { getHeaderValue?: (key: string) => string | undefined; original?: { ip?: string } }
    | undefined;
  let userAgent: string | null = null;
  try {
    userAgent = req?.getHeaderValue?.('user-agent') ?? null;
  } catch {
    userAgent = null;
  }
  return { ip: req?.original?.ip ?? null, userAgent };
}

export type LocalUser = typeof schema.users.$inferSelect;

@Injectable()
export class SupertokensService {
  private db: NodePgDatabase<typeof schema>;

  constructor(
    @Inject(ConfigInjectionToken) private config: AuthModuleConfig,
    @Inject('DATABASE_CONNECTION') db: NodePgDatabase<typeof schema>,
    @Optional() @Inject(TenantDbService) private readonly tenantDb?: TenantDbService,
    // Optional because both arrive with TenancyModule, which is only
    // registered when MULTI_TENANCY_ENABLED is set. Without them the app
    // authenticates exactly as before and simply records nothing.
    @Optional() @Inject(AuditService) private readonly audit?: AuditService,
    @Optional() @Inject(TenantRegistryService) private readonly registry?: TenantRegistryService,
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

              /**
               * Sign-in is the event an audit log exists for first.
               *
               * Both outcomes are recorded. A failed sign-in on its own is
               * noise; a run of them against one address is the signal, and a
               * log that keeps only successes cannot show one.
               *
               * The /auth routes are excluded from TenantMiddleware — they
               * answer before any tenant exists to resolve — so the tenant is
               * looked up here from the identity rather than read off the
               * request context, which would be empty.
               */
              signInPOST: async (input) => {
                const response = await originalImplementation.signInPOST!(input);
                const email = input.formFields.find((f) => f.id === 'email')?.value;

                if (response.status === 'OK') {
                  await this.recordAuth('auth.login', 'success', input, {
                    userId: response.user.id,
                    email: response.user.emails[0] ?? (typeof email === 'string' ? email : null),
                  });
                } else {
                  await this.recordAuth('auth.login', 'failure', input, {
                    userId: null,
                    email: typeof email === 'string' ? email : null,
                    reason: response.status,
                  });
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
          override: {
            apis: (originalImplementation) => ({
              ...originalImplementation,

              // Read before the sign-out, because afterwards there is no
              // session left to say whose it was.
              signOutPOST: async (input) => {
                const userId = input.session?.getUserId() ?? null;
                const response = await originalImplementation.signOutPOST!(input);
                await this.recordAuth('auth.logout', 'success', input, { userId, email: null });
                return response;
              },
            }),
          },
        }),
      ],
    });
  }

  /**
   * One place where an authentication event becomes an audit row.
   *
   * Private, and taking the SuperTokens API input directly, so the two call
   * sites in the constructor cannot drift apart on where the address, the user
   * agent or the tenant come from.
   *
   * A failed sign-in has no user id — the whole point is that the credentials
   * did not resolve to one — so the address it was attempted from and the
   * address it names are all the row has to work with.
   */
  private async recordAuth(
    event: 'auth.login' | 'auth.logout',
    outcome: 'success' | 'failure',
    input: { options?: { req?: unknown } },
    who: { userId: string | null; email: string | null; reason?: string },
  ): Promise<void> {
    if (!this.audit) return;

    const tenant = who.userId ? await this.registry?.forUser(who.userId).catch(() => null) : null;

    await this.audit.record({
      event,
      outcome,
      actorUserId: who.userId,
      actorEmail: who.email,
      subject: who.email ?? who.userId,
      tenantId: tenant?.tenantId ?? null,
      tenantSlug: tenant?.slug ?? null,
      detail: who.reason ? { reason: who.reason } : {},
      ...requestFacts(input),
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
