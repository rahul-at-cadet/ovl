import { Injectable, Inject } from '@nestjs/common';
import {
  createContext,
  publicProcedure,
  protectedProcedure,
  edgeProcedure,
  router,
  createCallerFactory,
  type Context,
} from './trpc.base';

// Re-exported so main.ts, the vessel's tRPC client and the tests keep importing
// these from here while the router is being split into per-domain files.
export { createContext, publicProcedure, protectedProcedure, edgeProcedure, router, createCallerFactory };
export type { Context };
import { Type, Static } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { DATABASE_CONNECTION } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, isNull, desc, sql, and, gt } from 'drizzle-orm';
import * as crypto from 'crypto';
import * as schema from '@ovl/database';

import * as trpcExpress from '@trpc/server/adapters/express';
import { SchemaVersionsService } from '../config/schema-versions/schema-versions.service';
import { FieldPolicyService } from '../config/field-policy/field-policy.service';
import { ComplianceService } from '../config/compliance/compliance.service';
import { ConfigBundleService } from '../config/config-bundle/config-bundle.service';
import { VesselUsersService } from '../vessels/vessel-users.service';
import { VesselsService } from '../vessels/vessels.service';
import { Scope } from '../config/logic/scope';
import { effectiveSeverities } from '../config/logic/compliance';
import { continuityConfigFor, revalidate, type ContinuityReport, type Severity } from '../config/logic/continuity';
import { SupertokensService } from '../auth/supertokens.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';
import { UserRole } from '../users/dto/create-user.dto';
import { createNotificationsRouter } from './notifications.router';
import { createEdgeRouter, createSyncRouter, type SyncRouterDeps } from './sync.router';
import { formatRelativeTime, ONLINE_THRESHOLD_MS } from './display';
import { createVesselsRouter } from './vessels.router';
import { createReportsRouter } from './reports.router';
import { createDashboardRouter, createCommercialRouter, type OfficeRouterDeps } from './office.router';
import {
  authenticateEdge as authenticateEdgeToken,
  assertEdgeKeyValid as assertEdgeKeyValidFor,
  type EdgeTokenContext,
} from './edge-auth';
import Session from 'supertokens-node/recipe/session';
import { TRPCError } from '@trpc/server';
import { Optional } from '@nestjs/common';
import { MasterCatalogService } from '../form-catalogue/master-catalog.service';
import { TenantCatalogService } from '../form-catalogue/tenant-catalog.service';
import { PlatformDbService } from '../tenancy/platform-db.service';
import { tryCurrentTenant, runAsSystemForTenant } from '../tenancy/tenant-context';
import { EdgeTenantResolverService } from '../tenancy/edge-tenant-resolver.service';
import { TenantDbService } from '../tenancy/tenant-db.service';




const PingSchema = Type.Object({ vesselId: Type.String() });
const PingCompiler = TypeCompiler.Compile(PingSchema);






// Design handoff B4's "send remark set" — a Reviewer flags one or more
// fields on a report in a single call (mirrors ovl/office/httpapi/remarks.go's
// createRemarkSetRequest).















const UpdateOfficeUserSchema = Type.Object({
  id: Type.String(),
  roles: Type.Optional(Type.Array(Type.String())),
  active: Type.Optional(Type.Boolean()),
});
const UpdateOfficeUserCompiler = TypeCompiler.Compile(UpdateOfficeUserSchema);

const DeleteOfficeUserSchema = Type.Object({
  id: Type.String(),
});
const DeleteOfficeUserCompiler = TypeCompiler.Compile(DeleteOfficeUserSchema);

const CreateOfficeUserSchema = Type.Object({
  username: Type.String(),
  roles: Type.Array(Type.Enum(UserRole), { minItems: 1 }),
});
const CreateOfficeUserCompiler = TypeCompiler.Compile(CreateOfficeUserSchema);

const ResetOfficeUserPasswordSchema = Type.Object({
  id: Type.String(),
});
const ResetOfficeUserPasswordCompiler = TypeCompiler.Compile(ResetOfficeUserPasswordSchema);


const GetSchemaFieldsSchema = Type.Object({
  schemaName: Type.String(),
});
const GetSchemaFieldsCompiler = TypeCompiler.Compile(GetSchemaFieldsSchema);





const CreateApiKeySchema = Type.Object({
  label: Type.String(),
  groupId: Type.Optional(Type.String()),
});
const CreateApiKeyCompiler = TypeCompiler.Compile(CreateApiKeySchema);

const RevokeApiKeySchema = Type.Object({
  id: Type.String(),
});
const RevokeApiKeyCompiler = TypeCompiler.Compile(RevokeApiKeySchema);

const PublishSchemaSchema = Type.Object({
  schemaName: Type.String(),
  version: Type.String(),
  source: Type.String(),
  content: Type.String(),
});
const PublishSchemaCompiler = TypeCompiler.Compile(PublishSchemaSchema);

const ScopeSchema = Type.Object({
  type: Type.Union([Type.Literal('fleet'), Type.Literal('group'), Type.Literal('vessel')]),
  key: Type.Optional(Type.String()),
});

const PublishConfigBundleSchema = Type.Object({
  label: Type.Optional(Type.String()),
});
const PublishConfigBundleCompiler = TypeCompiler.Compile(PublishConfigBundleSchema);

const GetFieldPolicySchema = Type.Object({
  schemaName: Type.String(),
  scopeType: Type.String(),
  scopeKey: Type.Optional(Type.String()),
});
const GetFieldPolicyCompiler = TypeCompiler.Compile(GetFieldPolicySchema);

const SaveFieldPolicySchema = Type.Object({
  schemaName: Type.String(),
  scopeType: Type.String(),
  scopeKey: Type.Optional(Type.String()),
  policy: Type.Any(),
  prefill: Type.Any(),
  events: Type.Any(),
});
const SaveFieldPolicyCompiler = TypeCompiler.Compile(SaveFieldPolicySchema);

const ListFieldPolicyAssignmentsSchema = Type.Object({
  schemaName: Type.String(),
});
const ListFieldPolicyAssignmentsCompiler = TypeCompiler.Compile(ListFieldPolicyAssignmentsSchema);

const PreviewSchemaUploadSchema = Type.Object({
  schemaName: Type.String(),
  content: Type.String(),
});
const PreviewSchemaUploadCompiler = TypeCompiler.Compile(PreviewSchemaUploadSchema);

const SaveProfileAssignmentSchema = Type.Object({
  scope: ScopeSchema,
  profiles: Type.Array(Type.String()),
});
const SaveProfileAssignmentCompiler = TypeCompiler.Compile(SaveProfileAssignmentSchema);

const SaveCadenceRuleSchema = Type.Object({
  scope: ScopeSchema,
  minReportIntervalHours: Type.Number(),
  maxGapHours: Type.Number(),
});
const SaveCadenceRuleCompiler = TypeCompiler.Compile(SaveCadenceRuleSchema);

const SaveRuleSeveritySchema = Type.Object({
  scope: ScopeSchema,
  severities: Type.Record(Type.String(), Type.String()),
});
const SaveRuleSeverityCompiler = TypeCompiler.Compile(SaveRuleSeveritySchema);

const AssignBundleSchema = Type.Object({
  scope: ScopeSchema,
  bundleId: Type.String(),
});
const AssignBundleCompiler = TypeCompiler.Compile(AssignBundleSchema);



// --- master form-schema catalogue ---------------------------------------

const CatalogueContentSchema = Type.Object({
  content: Type.String(),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
});
const CatalogueContentCompiler = TypeCompiler.Compile(CatalogueContentSchema);

const CatalogueSchemaNameSchema = Type.Object({ schemaName: Type.String() });
const CatalogueSchemaNameCompiler = TypeCompiler.Compile(CatalogueSchemaNameSchema);

const CatalogueVersionIdSchema = Type.Object({ versionId: Type.String() });
const CatalogueVersionIdCompiler = TypeCompiler.Compile(CatalogueVersionIdSchema);

const CatalogueForkSchema = Type.Object({
  masterVersionId: Type.String(),
  newVersion: Type.String(),
});
const CatalogueForkCompiler = TypeCompiler.Compile(CatalogueForkSchema);

const CatalogueDraftSchema = Type.Object({
  versionId: Type.String(),
  content: Type.String(),
});
const CatalogueDraftCompiler = TypeCompiler.Compile(CatalogueDraftSchema);

const CatalogueOptionalSchemaNameSchema = Type.Object({
  schemaName: Type.Optional(Type.String()),
});
const CatalogueOptionalSchemaNameCompiler = TypeCompiler.Compile(CatalogueOptionalSchemaNameSchema);

// What the vessel already holds, so the office can answer with only what
// differs. The link is satellite; re-sending five unchanged documents on every
// check-in is the difference between a sync that fits the window and one that
// does not.
const PullSchemasSchema = Type.Object({
  known: Type.Array(Type.Object({ schemaName: Type.String(), checksum: Type.String() })),
});
const PullSchemasCompiler = TypeCompiler.Compile(PullSchemasSchema);


@Injectable()
export class TrpcRouter {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly schemaVersionsService: SchemaVersionsService,
    private readonly fieldPolicyService: FieldPolicyService,
    private readonly complianceService: ComplianceService,
    private readonly configBundleService: ConfigBundleService,
    private readonly vesselUsersService: VesselUsersService,
    private readonly vesselsService: VesselsService,
    private readonly supertokensService: SupertokensService,
    private readonly notificationsService: NotificationsService,
    private readonly usersService: UsersService,
    // Optional because the form catalogue only exists when multi-tenancy is
    // enabled — TrpcRouter is constructed either way. The catalogue procedures
    // say so plainly rather than failing to resolve a dependency at boot.
    //
    // @Inject is required here, not decoration. A parameter typed
    // `Service | null` reflects as `Object` under emitDecoratorMetadata,
    // because a union has no single runtime constructor — so Nest has no token
    // to resolve and, being @Optional, quietly injects undefined. Everything
    // still boots, and every call silently behaves as though the catalogue were
    // switched off. Naming the token explicitly is what makes the injection
    // actually happen.
    @Optional() @Inject(MasterCatalogService) private readonly masterCatalog?: MasterCatalogService,
    @Optional() @Inject(TenantCatalogService) private readonly tenantCatalog?: TenantCatalogService,
    @Optional() @Inject(PlatformDbService) private readonly platformDb?: PlatformDbService,
    @Optional() @Inject(EdgeTenantResolverService) private readonly edgeTenants?: EdgeTenantResolverService,
    @Optional() @Inject(TenantDbService) private readonly tenantDb?: TenantDbService,
  ) {}

  /** Throws unless the catalogue is wired up. */
  private requireCatalogue<T>(service: T | undefined): T {
    if (!service) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'The form-schema catalogue requires MULTI_TENANCY_ENABLED=true.',
      });
    }
    return service;
  }

  /**
   * The SuperTokens id of the caller, having confirmed they are a platform
   * super admin.
   *
   * Checked here *and* enforced again by Postgres: MasterCatalogService writes
   * through PlatformDbService.asPublisher, which re-checks and then assumes the
   * platform_publisher role. This check exists to return a clean 403 at the
   * edge; the role assumption is what makes bypassing it impossible.
   */
  private async requireSuperAdmin(ctx: { session: { getUserId(): string } }): Promise<string> {
    const platform = this.requireCatalogue(this.platformDb);
    const userId = ctx.session.getUserId();
    if (!(await platform.isSuperAdmin(userId))) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'This action requires a platform super admin.',
      });
    }
    return userId;
  }

  /**
   * Proves an edge caller holds the whole API key, inside the tenant its
   * lookup hash pointed at.
   *
   * Separate from tenant resolution on purpose. Resolution says where to look;
   * this says whether the caller is who they claim. Collapsing the two would
   * make the platform index — which stores a truncated hash and is not a
   * secret — into the thing that grants access.
   */


  /** What the extracted office-side routers need, resolved per call. */
  private officeDeps(): OfficeRouterDeps {
    return {
      db: this.db,
      tenantDb: this.tenantDb,
      supertokensService: this.supertokensService,
      notificationsService: this.notificationsService,
      schemaVersionsService: this.schemaVersionsService,
    };
  }

  /** What the extracted vessel-facing routers need, resolved per call. */
  private syncDeps(): SyncRouterDeps {
    return {
      db: this.db,
      configBundleService: this.configBundleService,
      vesselUsersService: this.vesselUsersService,
      complianceService: this.complianceService,
      edgeTenants: this.edgeTenants,
      tenantDb: this.tenantDb,
      tenantCatalog: this.tenantCatalog,
    };
  }

  /** Authenticates a vessel. See edge-auth.ts for why this is two steps. */
  private authenticateEdge(ctx: EdgeTokenContext): Promise<void> {
    return authenticateEdgeToken(
      { db: this.db, edgeTenants: this.edgeTenants, tenantDb: this.tenantDb },
      ctx,
    );
  }

  /** Verifies a full token hash inside the already-entered tenant context. */
  private assertEdgeKeyValid(tokenHash: string): Promise<void> {
    return assertEdgeKeyValidFor(this.requireCatalogue(this.tenantDb), tokenHash);
  }

  /** The active tenant, or a clean 403 rather than a 500 from deeper down. */
  private requireTenant() {
    const tenant = tryCurrentTenant();
    if (!tenant) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'No tenant is associated with this account.',
      });
    }
    return tenant;
  }


  appRouter = router({
    /**
     * The master form-schema catalogue, and each tenant's adoptions of it.
     *
     * `catalogue.master.*` is super-admin only: a platform super admin
     * publishes documents every tenant may choose from. `catalogue.tenant.*`
     * is what a tenant administrator uses to adopt one, fork it, or publish
     * their own — a tenant can never write a master schema, and its database
     * role holds only SELECT on the catalogue, so that is enforced below the
     * application rather than by these checks alone.
     */
    catalogue: router({
      /** What the current caller may do — drives which UI is offered. */
      whoami: protectedProcedure.query(async ({ ctx }) => {
        const tenant = tryCurrentTenant();
        const isSuperAdmin = this.platformDb
          ? await this.platformDb.isSuperAdmin(ctx.session.getUserId())
          : false;
        return {
          // Boolean(), not `!== null`: an unresolved optional dependency
          // arrives as undefined, which `!== null` reports as present.
          enabled: Boolean(this.platformDb),
          isSuperAdmin,
          tenant: tenant ? { slug: tenant.slug, tenantId: tenant.tenantId } : null,
        };
      }),

      master: router({
        list: protectedProcedure.query(() =>
          this.requireCatalogue(this.masterCatalog).listSchemas(),
        ),

        versions: protectedProcedure
          .input((val: unknown) => {
            if (!CatalogueSchemaNameCompiler.Check(val)) throw new Error('Invalid input');
            return val as Static<typeof CatalogueSchemaNameSchema>;
          })
          .query(({ input }) =>
            this.requireCatalogue(this.masterCatalog).listVersions(input.schemaName),
          ),

        // A mutation rather than a query because it is an upload being checked,
        // not addressable state — the same shape the existing schema preview uses.
        preview: protectedProcedure
          .input((val: unknown) => {
            if (!CatalogueContentCompiler.Check(val)) throw new Error('Invalid input');
            return val as Static<typeof CatalogueContentSchema>;
          })
          .mutation(async ({ input, ctx }) => {
            await this.requireSuperAdmin(ctx);
            return this.requireCatalogue(this.masterCatalog).preview(input.content);
          }),

        publish: protectedProcedure
          .input((val: unknown) => {
            if (!CatalogueContentCompiler.Check(val)) throw new Error('Invalid input');
            return val as Static<typeof CatalogueContentSchema>;
          })
          .mutation(async ({ input, ctx }) => {
            const userId = await this.requireSuperAdmin(ctx);
            return this.requireCatalogue(this.masterCatalog).publish(userId, {
              content: input.content,
              title: input.title,
              description: input.description,
            });
          }),

        deprecate: protectedProcedure
          .input((val: unknown) => {
            if (!CatalogueVersionIdCompiler.Check(val)) throw new Error('Invalid input');
            return val as Static<typeof CatalogueVersionIdSchema>;
          })
          .mutation(async ({ input, ctx }) => {
            const userId = await this.requireSuperAdmin(ctx);
            return this.requireCatalogue(this.masterCatalog).deprecateVersion(
              userId,
              input.versionId,
            );
          }),
      }),

      /**
       * What a vessel pulls down.
       *
       * Authenticated by API key, not by session, so the tenant is resolved
       * from the key rather than from an ambient context — and then the key's
       * full hash is verified *inside* that tenant's schema. A lookup-hash
       * match alone proves nothing; treating it as authentication would turn a
       * prefix collision into a bypass.
       */
      edge: router({
        pullSchemas: edgeProcedure
          .input((val: unknown) => {
            if (!PullSchemasCompiler.Check(val)) throw new Error('Invalid input');
            return val as Static<typeof PullSchemasSchema>;
          })
          .query(async ({ input, ctx }) => {
            const resolver = this.requireCatalogue(this.edgeTenants);
            const tenant = await resolver.resolve(ctx.tokenLookupHash);
            if (!tenant) {
              throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Unknown API key' });
            }

            return runAsSystemForTenant({ ...tenant, requestId: 'edge-pull-schemas' }, async () => {
              // The actual authentication step. The lookup hash only said
              // which tenant to look in; this proves the caller holds the whole
              // token, and it happens against that tenant's own api_keys.
              await this.assertEdgeKeyValid(ctx.tokenHash);

              const effective = await this.requireCatalogue(this.tenantCatalog).resolveAll();
              const known = new Map(input.known.map((k) => [k.schemaName, k.checksum]));

              return {
                // Only what the vessel does not already have, byte for byte.
                changed: effective
                  .filter((s) => known.get(s.schemaName) !== s.contentChecksum)
                  .map((s) => ({
                    schemaName: s.schemaName,
                    version: s.version,
                    checksum: s.contentChecksum,
                    content: JSON.stringify(s.content),
                  })),
                // Schemas the vessel holds that this tenant no longer uses.
                // Without this, un-adopting would leave the form on every
                // vessel forever.
                removed: [...known.keys()].filter(
                  (name) => !effective.some((s) => s.schemaName === name),
                ),
                syncedAt: new Date().toISOString(),
              };
            });
          }),
      }),

      tenant: router({
        /** Every master schema, annotated with this tenant's adoption state. */
        browse: protectedProcedure.query(() => {
          this.requireTenant();
          return this.requireCatalogue(this.tenantCatalog).browse();
        }),

        resolve: protectedProcedure
          .input((val: unknown) => {
            if (!CatalogueSchemaNameCompiler.Check(val)) throw new Error('Invalid input');
            return val as Static<typeof CatalogueSchemaNameSchema>;
          })
          .query(({ input }) => {
            this.requireTenant();
            return this.requireCatalogue(this.tenantCatalog).resolve(input.schemaName);
          }),

        listOwn: protectedProcedure
          .input((val: unknown) => {
            if (!CatalogueOptionalSchemaNameCompiler.Check(val)) throw new Error('Invalid input');
            return val as Static<typeof CatalogueOptionalSchemaNameSchema>;
          })
          .query(({ input }) => {
            this.requireTenant();
            return this.requireCatalogue(this.tenantCatalog).listOwnVersions(input.schemaName);
          }),

        adopt: protectedProcedure
          .input((val: unknown) => {
            if (!CatalogueVersionIdCompiler.Check(val)) throw new Error('Invalid input');
            return val as Static<typeof CatalogueVersionIdSchema>;
          })
          .mutation(({ input, ctx }) => {
            this.requireTenant();
            return this.requireCatalogue(this.tenantCatalog).adoptMaster(
              input.versionId,
              ctx.session.getUserId(),
            );
          }),

        unadopt: protectedProcedure
          .input((val: unknown) => {
            if (!CatalogueSchemaNameCompiler.Check(val)) throw new Error('Invalid input');
            return val as Static<typeof CatalogueSchemaNameSchema>;
          })
          .mutation(({ input }) => {
            this.requireTenant();
            return this.requireCatalogue(this.tenantCatalog).unadopt(input.schemaName);
          }),

        /**
         * "Edit this master schema" is expressed as fork — the master document
         * is not writable by a tenant at all. The copy starts as a draft, so a
         * half-finished edit never reaches a vessel.
         */
        fork: protectedProcedure
          .input((val: unknown) => {
            if (!CatalogueForkCompiler.Check(val)) throw new Error('Invalid input');
            return val as Static<typeof CatalogueForkSchema>;
          })
          .mutation(({ input, ctx }) => {
            this.requireTenant();
            return this.requireCatalogue(this.tenantCatalog).fork(
              input.masterVersionId,
              input.newVersion,
              ctx.session.getUserId(),
            );
          }),

        createOwn: protectedProcedure
          .input((val: unknown) => {
            if (!CatalogueContentCompiler.Check(val)) throw new Error('Invalid input');
            return val as Static<typeof CatalogueContentSchema>;
          })
          .mutation(({ input, ctx }) => {
            this.requireTenant();
            return this.requireCatalogue(this.tenantCatalog).createOwn(
              input.content,
              ctx.session.getUserId(),
            );
          }),

        updateDraft: protectedProcedure
          .input((val: unknown) => {
            if (!CatalogueDraftCompiler.Check(val)) throw new Error('Invalid input');
            return val as Static<typeof CatalogueDraftSchema>;
          })
          .mutation(({ input }) => {
            this.requireTenant();
            return this.requireCatalogue(this.tenantCatalog).updateDraft(
              input.versionId,
              input.content,
            );
          }),

        publishOwn: protectedProcedure
          .input((val: unknown) => {
            if (!CatalogueVersionIdCompiler.Check(val)) throw new Error('Invalid input');
            return val as Static<typeof CatalogueVersionIdSchema>;
          })
          .mutation(({ input, ctx }) => {
            this.requireTenant();
            return this.requireCatalogue(this.tenantCatalog).publishOwn(
              input.versionId,
              ctx.session.getUserId(),
            );
          }),

        /** What this fork changed, and what master has changed since. */
        divergence: protectedProcedure
          .input((val: unknown) => {
            if (!CatalogueVersionIdCompiler.Check(val)) throw new Error('Invalid input');
            return val as Static<typeof CatalogueVersionIdSchema>;
          })
          .query(({ input }) => {
            this.requireTenant();
            return this.requireCatalogue(this.tenantCatalog).forkDivergence(input.versionId);
          }),
      }),
    }),

    ping: publicProcedure
      .input((val: unknown) => {
        if (!PingCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof PingSchema>;
      })
      .query(({ input }) => {
        return {
          message: `Pong received from Office API for vessel ${input.vesselId}`,
          timestamp: new Date().toISOString(),
        };
      }),

    // Extracted to sync.router.ts — the vessel-facing path, kept in its own
    // file so the tenancy migration can change it in a reviewable diff.
    edge: createEdgeRouter(() => this.syncDeps()),
    sync: createSyncRouter(() => this.syncDeps()),

    // Extracted to vessels.router.ts.
    vessels: createVesselsRouter(() => ({
      db: this.db,
      tenantDb: this.tenantDb,
      supertokensService: this.supertokensService,
      vesselsService: this.vesselsService,
      vesselUsersService: this.vesselUsersService,
    })),

    users: router({
      list: protectedProcedure.query(async () => {
        const officeUsers = await this.db.select().from(schema.users);
        return officeUsers.map(u => ({
          id: u.id,
          username: u.username,
          roles: u.roles,
          active: u.active,
          createdAt: u.createdAt,
        }));
      }),
      update: protectedProcedure
        .input((val: unknown) => {
          if (!UpdateOfficeUserCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof UpdateOfficeUserSchema>;
        })
        .mutation(async ({ input }) => {
          const { id, ...updates } = input;
          const updatedUser = await this.db.update(schema.users).set({
            ...updates,
            updatedAt: new Date().toISOString(),
          }).where(eq(schema.users.id, id)).returning();
          return updatedUser[0];
        }),
      delete: protectedProcedure
        .input((val: unknown) => {
          if (!DeleteOfficeUserCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof DeleteOfficeUserSchema>;
        })
        .mutation(async ({ input }) => {
          await this.db.delete(schema.users).where(eq(schema.users.id, input.id));
          return { success: true };
        }),
      // Delegates to UsersService rather than reimplementing here — it
      // provisions a real SuperTokens login (not just this table's own
      // row), which needs the SuperTokens SDK calls that already live
      // there. See UsersService.createUser's own doc comment.
      //
      // publicProcedure, not protectedProcedure: this is also the
      // bootstrap path for the very first (Admin) account, when there's
      // no session to require yet (mirrors ovl/office/httpapi's
      // handleSetupAdmin — a one-time exception the original scopes to
      // a dedicated setup screen, same rule applied here instead of a
      // second endpoint) and the vessel app's own identical bootstrap
      // exception for users.create. Once any user exists, this requires
      // a valid admin session — otherwise anyone could mint arbitrary
      // accounts at any time.
      create: publicProcedure
        .input((val: unknown) => {
          if (!CreateOfficeUserCompiler.Check(val)) throw new Error('Invalid input');
          const parsed = val as Static<typeof CreateOfficeUserSchema>;
          // Deliberately not `Type.String({ format: 'email' })`: with no
          // format validator registered (none is, in this project),
          // TypeBox's compiled checker doesn't skip the hint, it treats
          // the format as unsatisfiable and rejects every value — which
          // made this procedure 400 unconditionally, blocking even the
          // very first admin bootstrap. Checked for real here instead.
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parsed.username)) {
            throw new Error('username must be a valid email');
          }
          return parsed;
        })
        .mutation(async ({ input, ctx }) => {
          // No unauthenticated bootstrap any more.
          //
          // This used to let the very first account be created with no session,
          // because a fresh single-tenant install had no admin yet. Under
          // multi-tenancy that hole cannot stay open and is not needed: a
          // tenant's first admin is created by a platform super admin when the
          // tenant is registered (see TenantProvisioningService.createFirstAdmin),
          // with a temporary password the admin must change at first sign-in.
          // Every account after that is created by an authenticated tenant
          // admin, which is what this procedure is now for.
          const session = await Session.getSession(ctx.req, ctx.res, { sessionRequired: false }).catch(
            () => undefined,
          );
          const localUser = session
            ? await this.supertokensService.getLocalUser(session.getUserId())
            : null;
          if (!localUser || !(localUser.roles as string[]).includes('admin')) {
            throw new TRPCError({
              code: 'UNAUTHORIZED',
              message: 'Admin login required to create users.',
            });
          }
          return this.usersService.createUser(input);
        }),
      resetPassword: protectedProcedure
        .input((val: unknown) => {
          if (!ResetOfficeUserPasswordCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof ResetOfficeUserPasswordSchema>;
        })
        .mutation(({ input }) => this.usersService.resetUserPassword(input.id)),
    }),
    fieldPolicies: router({
      get: protectedProcedure
        .input((val: unknown) => {
          if (!GetFieldPolicyCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof GetFieldPolicySchema>;
        })
        .query(({ input }) => {
          const scope: Scope = { type: input.scopeType as Scope['type'], key: input.scopeKey };
          return this.fieldPolicyService.get(input.schemaName, scope);
        }),
      save: protectedProcedure
        .input((val: unknown) => {
          if (!SaveFieldPolicyCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof SaveFieldPolicySchema>;
        })
        .mutation(({ input }) => {
          const scope: Scope = { type: input.scopeType as Scope['type'], key: input.scopeKey };
          return this.fieldPolicyService.save(input.schemaName, scope, input.policy, input.prefill, input.events);
        }),
      listAssignments: protectedProcedure
        .input((val: unknown) => {
          if (!ListFieldPolicyAssignmentsCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof ListFieldPolicyAssignmentsSchema>;
        })
        .query(({ input }) => this.fieldPolicyService.listAssignments(input.schemaName)),
    }),
    // Extracted to reports.router.ts.
    reports: createReportsRouter(() => ({
      db: this.db,
      tenantDb: this.tenantDb,
      supertokensService: this.supertokensService,
    })),
    // The first call site migrated off the shared schema, and the one that had
    // to go first: edge authentication resolves a vessel's key to a tenant and
    // then verifies it *inside* that tenant's schema, so the key has to live
    // there. Left on the legacy `public` connection, the pointer would resolve
    // and the verification would then look in the wrong place and fail.
    apiKeys: router({
      list: protectedProcedure.query(async () => {
        this.requireTenant();
        return this.requireCatalogue(this.tenantDb).withTenant(
          (db) => db.select().from(schema.apiKeys).where(isNull(schema.apiKeys.revokedAt)),
          { readOnly: true },
        );
      }),
      create: protectedProcedure
        .input((val: unknown) => {
          if (!CreateApiKeyCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof CreateApiKeySchema>;
        })
        .mutation(async ({ input }) => {
          const rawToken = crypto.randomBytes(32).toString('hex');
          const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
          const tokenLookupHash = crypto.createHash('sha256').update(rawToken.substring(0, 8)).digest('hex');
          
          this.requireTenant();
          const newKey = await this.requireCatalogue(this.tenantDb).withTenant((db) =>
            db
              .insert(schema.apiKeys)
              .values({
                label: input.label,
                tokenHash,
                tokenLookupHash,
                groupId: input.groupId || null,
                createdBy: 'System',
                createdAt: new Date().toISOString(),
              })
              .returning(),
          );

          // Record which tenant this key belongs to, so edge traffic can find
          // its way back. Vessels authenticate with a bearer token and have no
          // session, and the api_keys row above lives inside a tenant schema —
          // without this pointer there is no way to know which schema to look
          // in. Written through a dormant role a tenant cannot assume.
          const tenant = tryCurrentTenant();
          if (tenant && this.edgeTenants) {
            await this.edgeTenants.register(tokenLookupHash, tenant.tenantId, input.label);
          }

          return {
            key: newKey[0],
            rawToken: `ovl_prod_${rawToken}`,
          };
        }),
      revoke: protectedProcedure
        .input((val: unknown) => {
          if (!RevokeApiKeyCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof RevokeApiKeySchema>;
        })
        .mutation(async ({ input }) => {
          this.requireTenant();
          const [revoked] = await this.requireCatalogue(this.tenantDb).withTenant((db) =>
            db
              .update(schema.apiKeys)
              .set({ revokedAt: new Date().toISOString() })
              .where(eq(schema.apiKeys.id, input.id))
              .returning(),
          );

          // Stop the key resolving a tenant at all. The api_keys row above is
          // still the authority on whether it works — this only closes the
          // door one step earlier, and keeps revocation auditable rather than
          // deleting the pointer outright.
          if (revoked?.tokenLookupHash && this.edgeTenants) {
            await this.edgeTenants.revoke(revoked.tokenLookupHash);
          }
          return { success: true };
        }),
    }),
    setup: router({
      // Drives the login page's choice between the normal sign-in form
      // and a one-time "create the first Admin account" form — mirrors
      // ovl/office/httpapi's GET /api/setup/status (hasAnyUser) feeding
      // web/office's SetupAdmin screen. publicProcedure: this has to be
      // checkable before anyone can possibly have a session yet.
      status: publicProcedure.query(async () => {
        const rows = await this.db.select({ id: schema.users.id }).from(schema.users).limit(1);
        return { hasAnyUser: rows.length > 0 };
      }),
    }),
    // Ports ovl/office/httpapi/system.go's System tab — real values
    // only. Attachment-store usage isn't included: unlike the original,
    // this port has no attachment-store feature on the office side to
    // report on, so an honest "not wired yet" row is more truthful than
    // fabricating byte/file counts for a store that doesn't exist here.
    system: router({
      get: protectedProcedure.query(async () => {
        let databaseReachable = true;
        try {
          await this.db.execute(sql`select 1`);
        } catch {
          databaseReachable = false;
        }
        return {
          version: process.env.npm_package_version || '0.0.1',
          databaseReachable,
        };
      }),
    }),
    // Extracted to office.router.ts.
    dashboard: createDashboardRouter(() => this.officeDeps()),
    // Extracted to notifications.router.ts. See that file for why the router
    // is being split into per-domain modules.
    // Extracted to notifications.router.ts. See that file for why the router
    // is being split into per-domain modules.
    notifications: createNotificationsRouter(() => ({
      supertokensService: this.supertokensService,
      notificationsService: this.notificationsService,
    })),

    schemas: router({
      list: protectedProcedure.query(() => this.schemaVersionsService.list()),
      // Field definitions (name/label/section) for the latest published
      // version of a schema — drives the report detail screen's section
      // grouping, ported from the original's own sections.ts/
      // fieldGrouping.ts (see that comment on the reports/[id] page for
      // the full rationale).
      getFields: protectedProcedure
        .input((val: unknown) => {
          if (!GetSchemaFieldsCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof GetSchemaFieldsSchema>;
        })
        .query(({ input }) => this.schemaVersionsService.getLatestFields(input.schemaName)),
      preview: protectedProcedure
        .input((val: unknown) => {
          if (!PreviewSchemaUploadCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof PreviewSchemaUploadSchema>;
        })
        .mutation(({ input }) => this.schemaVersionsService.preview(input.schemaName, input.content)),
      publish: protectedProcedure
        .input((val: unknown) => {
          if (!PublishSchemaCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof PublishSchemaSchema>;
        })
        .mutation(({ input }) => this.schemaVersionsService.publish(input)),
    }),
    // Ports ovl/office/httpapi/commercial.go — office-authored data
    // (architecture 12.2, Commercial Editor role): the only two schemas
    // that are ever entered here rather than synced up from a vessel. A
    // one-shot submit, not a draft — nothing persists until the health
    // check passes, same as the original's own scope note on why (this
    // port's report_versions has no equivalent of vessel-side draft
    // rows/section locks to build a save-progressively flow on top of).
    // Extracted to office.router.ts.
    commercial: createCommercialRouter(() => this.officeDeps()),
    configBundles: router({
      list: protectedProcedure.query(() => this.configBundleService.list()),
      preview: protectedProcedure.query(() => this.configBundleService.preview()),
      publish: protectedProcedure
        .input((val: unknown) => {
          if (!PublishConfigBundleCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof PublishConfigBundleSchema>;
        })
        .mutation(({ input }) => this.configBundleService.publish(input.label || '')),
      assign: protectedProcedure
        .input((val: unknown) => {
          if (!AssignBundleCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof AssignBundleSchema>;
        })
        .mutation(({ input }) => this.configBundleService.assign(input.scope as Scope, input.bundleId)),
      listAssignments: protectedProcedure.query(() => this.configBundleService.listAssignments()),
      vesselConfigs: protectedProcedure.query(() => this.configBundleService.vesselConfigs()),
      // Shore-side sync history. Optionally narrowed to one vessel; without a
      // filter it is the fleet's check-in log, which is where an unknown
      // vessel repeatedly failing to enrol becomes visible.
      syncHistory: protectedProcedure
        .input((val: unknown) => {
          const v = (val ?? {}) as { vesselId?: string; limit?: number };
          // vesselId stays genuinely optional in the returned type. Spelling it
          // as `vesselId: v.vesselId` would infer `string | undefined` as a
          // *required* property, forcing every caller to pass it explicitly —
          // which is what broke the production type check, since next dev
          // never type-checks and only `next build` catches it.
          const parsed: { vesselId?: string; limit: number } = {
            limit: typeof v.limit === 'number' ? v.limit : 50,
          };
          if (typeof v.vesselId === 'string' && v.vesselId) parsed.vesselId = v.vesselId;
          return parsed;
        })
        .query(({ input }) => this.configBundleService.syncHistory(input.vesselId, input.limit)),
    }),
    compliance: router({
      ruleCatalog: protectedProcedure.query(() => this.complianceService.ruleCatalog()),
      listProfiles: protectedProcedure.query(() => this.complianceService.listProfiles()),
      saveProfile: protectedProcedure
        .input((val: unknown) => {
          if (!SaveProfileAssignmentCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof SaveProfileAssignmentSchema>;
        })
        .mutation(({ input }) => this.complianceService.saveProfile(input.scope as Scope, input.profiles)),
      listCadenceRules: protectedProcedure.query(() => this.complianceService.listCadenceRules()),
      saveCadenceRule: protectedProcedure
        .input((val: unknown) => {
          if (!SaveCadenceRuleCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof SaveCadenceRuleSchema>;
        })
        .mutation(({ input }) =>
          this.complianceService.saveCadenceRule(input.scope as Scope, input.minReportIntervalHours, input.maxGapHours),
        ),
      listRuleSeverities: protectedProcedure.query(() => this.complianceService.listRuleSeverities()),
      saveRuleSeverity: protectedProcedure
        .input((val: unknown) => {
          if (!SaveRuleSeverityCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof SaveRuleSeveritySchema>;
        })
        .mutation(({ input }) => this.complianceService.saveRuleSeverity(input.scope as Scope, input.severities)),
    }),
  });
}

export type AppRouter = TrpcRouter['appRouter'];
