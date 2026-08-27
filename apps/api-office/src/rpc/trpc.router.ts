import { Injectable, Inject } from '@nestjs/common';
import { initTRPC } from '@trpc/server';
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
import Session from 'supertokens-node/recipe/session';
import { TRPCError } from '@trpc/server';
import { Optional } from '@nestjs/common';
import { MasterCatalogService } from '../form-catalogue/master-catalog.service';
import { TenantCatalogService } from '../form-catalogue/tenant-catalog.service';
import { PlatformDbService } from '../tenancy/platform-db.service';
import { tryCurrentTenant, runAsSystemForTenant } from '../tenancy/tenant-context';
import { EdgeTenantResolverService } from '../tenancy/edge-tenant-resolver.service';
import { TenantDbService } from '../tenancy/tenant-db.service';

function formatRelativeTime(thenMs: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - thenMs) / 1000));
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

// A vessel counts as "online" if it's checked in within this window —
// shared by the Vessels list's edgeStatus badge and the dashboard's
// fleet-wide sync health, so the two views can never disagree about
// what "online" means.
const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;

export const createContext = ({
  req,
  res,
}: trpcExpress.CreateExpressContextOptions) => {
  return {
    req,
    res,
  };
};

export type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create();

const PingSchema = Type.Object({ vesselId: Type.String() });
const PingCompiler = TypeCompiler.Compile(PingSchema);

const PushEventsSchema = Type.Object({
  vesselId: Type.String(),
  events: Type.Array(
    Type.Object({
      id: Type.String(),
      eventType: Type.String(),
      payload: Type.String(),
      createdAt: Type.String(),
      processedAt: Type.Union([Type.String(), Type.Null()]),
    })
  )
});
const PushEventsCompiler = TypeCompiler.Compile(PushEventsSchema);

const PullConfigInputSchema = Type.Object({
  vesselId: Type.String(),
  lastSyncAt: Type.Optional(Type.String()),
  // Architecture 9.3/12.4's remote user administration, piggybacked on
  // this same check-in rather than a dedicated RPC (mirrors
  // ovl/office/syncservice's SyncStatus fields of the same names): the
  // vessel's full current roster (mirrored into vessel_users wholesale)
  // and the command IDs it confirms applying since its last check-in.
  users: Type.Optional(Type.Array(Type.Object({
    username: Type.String(),
    role: Type.String(),
    active: Type.Boolean(),
    canSubmit: Type.Boolean(),
    updatedAt: Type.String(),
  }))),
  appliedUserCommandIds: Type.Optional(Type.Array(Type.String())),
  // Chat's pull-down cursor (office-authored messages only — the
  // vessel's own messages already reach office via pushEvents'
  // chat_sent handling). "0" pulls everything; chat_messages.seq is a
  // Postgres bigserial, so this arrives as a string (see the userCommand
  // seq BigInt-serialization comment on VesselUsersService).
  lastChatSeq: Type.Optional(Type.String()),
  // Remarks' pull-down cursor, same shape as lastChatSeq — remarks are
  // office-authored only (a Reviewer flags a submitted report), so there
  // is no equivalent upstream direction to worry about.
  lastRemarkSeq: Type.Optional(Type.String()),
  // Invalidation notices' pull-down cursor, same shape — computed
  // office-side only (cascade revalidation), no upstream direction.
  lastInvalidationSeq: Type.Optional(Type.String()),
});
const PullConfigInputCompiler = TypeCompiler.Compile(PullConfigInputSchema);

const GetChatSchema = Type.Object({ reportId: Type.String() });
const GetChatCompiler = TypeCompiler.Compile(GetChatSchema);

const SendChatMessageSchema = Type.Object({ reportId: Type.String(), body: Type.String() });
const SendChatMessageCompiler = TypeCompiler.Compile(SendChatMessageSchema);

// Architecture 12.3: "text-only, size-capped" — enforced on every write
// path on both sides (mirrors pkg/domain.MaxChatBodyBytes), so the cap
// can't drift between office's and the vessel's send paths.
const MAX_CHAT_BODY_BYTES = 4096;

// Design handoff B4's "send remark set" — a Reviewer flags one or more
// fields on a report in a single call (mirrors ovl/office/httpapi/remarks.go's
// createRemarkSetRequest).
const CreateRemarkSetSchema = Type.Object({
  reportId: Type.String(),
  remarks: Type.Array(Type.Object({ fieldName: Type.String(), body: Type.String() }), { minItems: 1 }),
});
const CreateRemarkSetCompiler = TypeCompiler.Compile(CreateRemarkSetSchema);

const ListRemarksSchema = Type.Object({ reportId: Type.String() });
const ListRemarksCompiler = TypeCompiler.Compile(ListRemarksSchema);

const SetRemarkResolvedSchema = Type.Object({ id: Type.String(), resolved: Type.Boolean() });
const SetRemarkResolvedCompiler = TypeCompiler.Compile(SetRemarkResolvedSchema);

const VesselIdInputSchema = Type.Object({
  vesselId: Type.String(),
});
const VesselIdInputCompiler = TypeCompiler.Compile(VesselIdInputSchema);

const QueueCreateUserSchema = Type.Object({
  vesselId: Type.String(),
  username: Type.String(),
  role: Type.String(),
});
const QueueCreateUserCompiler = TypeCompiler.Compile(QueueCreateUserSchema);

const QueueUsernameActionSchema = Type.Object({
  vesselId: Type.String(),
  username: Type.String(),
});
const QueueUsernameActionCompiler = TypeCompiler.Compile(QueueUsernameActionSchema);

const QueueSetRoleSchema = Type.Object({
  vesselId: Type.String(),
  username: Type.String(),
  role: Type.String(),
});
const QueueSetRoleCompiler = TypeCompiler.Compile(QueueSetRoleSchema);

const QueueSetActiveSchema = Type.Object({
  vesselId: Type.String(),
  username: Type.String(),
  active: Type.Boolean(),
});
const QueueSetActiveCompiler = TypeCompiler.Compile(QueueSetActiveSchema);

const QueueSetCanSubmitSchema = Type.Object({
  vesselId: Type.String(),
  username: Type.String(),
  canSubmit: Type.Boolean(),
});
const QueueSetCanSubmitCompiler = TypeCompiler.Compile(QueueSetCanSubmitSchema);

const ListVesselPositionsSchema = Type.Object({
  group: Type.Optional(Type.String()),
});
const ListVesselPositionsCompiler = TypeCompiler.Compile(ListVesselPositionsSchema);

const CreateVesselSchema = Type.Object({
  name: Type.String(),
  imo: Type.String(),
  type: Type.String(),
  groups: Type.Optional(Type.Array(Type.String())),
});
const CreateVesselCompiler = TypeCompiler.Compile(CreateVesselSchema);

const UpdateVesselSchema = Type.Object({
  id: Type.String(),
  name: Type.Optional(Type.String()),
  imo: Type.Optional(Type.String()),
  type: Type.Optional(Type.String()),
  groups: Type.Optional(Type.Array(Type.String())),
});
const UpdateVesselCompiler = TypeCompiler.Compile(UpdateVesselSchema);

const DeleteVesselSchema = Type.Object({
  id: Type.String(),
});
const DeleteVesselCompiler = TypeCompiler.Compile(DeleteVesselSchema);

const RenameVesselGroupSchema = Type.Object({
  from: Type.String(),
  to: Type.String(),
});
const RenameVesselGroupCompiler = TypeCompiler.Compile(RenameVesselGroupSchema);

const DeleteVesselGroupSchema = Type.Object({
  group: Type.String(),
});
const DeleteVesselGroupCompiler = TypeCompiler.Compile(DeleteVesselGroupSchema);

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

const GetReportSchema = Type.Object({
  reportId: Type.String(),
});
const GetReportCompiler = TypeCompiler.Compile(GetReportSchema);

const GetSchemaFieldsSchema = Type.Object({
  schemaName: Type.String(),
});
const GetSchemaFieldsCompiler = TypeCompiler.Compile(GetSchemaFieldsSchema);

const COMMERCIAL_SCHEMA_LABELS: Record<string, string> = {
  'commercial-period': 'Commercial Period',
  'cargo-nomination': 'Cargo Nomination',
};

const ListCommercialReportsSchema = Type.Object({
  schemaName: Type.String(),
});
const ListCommercialReportsCompiler = TypeCompiler.Compile(ListCommercialReportsSchema);

const CreateCommercialReportSchema = Type.Object({
  schemaName: Type.String(),
  vesselId: Type.String(),
  fields: Type.Record(Type.String(), Type.Any()),
});
const CreateCommercialReportCompiler = TypeCompiler.Compile(CreateCommercialReportSchema);

const MarkReviewedSchema = Type.Object({
  reportId: Type.String(),
});
const MarkReviewedCompiler = TypeCompiler.Compile(MarkReviewedSchema);

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

const EnrollEdgeSchema = Type.Object({
  vesselName: Type.String(),
  imoNumber: Type.String(),
});
const EnrollEdgeCompiler = TypeCompiler.Compile(EnrollEdgeSchema);

const MarkNotificationsReadSchema = Type.Object({
  ids: Type.Array(Type.String()),
});
const MarkNotificationsReadCompiler = TypeCompiler.Compile(MarkNotificationsReadSchema);

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

export const publicProcedure = t.procedure;
export const router = t.router;

/**
 * Builds an in-process caller for a router.
 *
 * Exported for the sync contract tests, which drive the real edge and sync
 * procedures — authentication included — against a live database without
 * standing up an HTTP server. The alternative, asserting against mocks, would
 * only prove the mocks behave as the test expects, and the properties that
 * matter here (a key verified in the right schema, a cascade committing with
 * the version that triggered it) are exactly the ones a mock cannot show.
 */
export const createCallerFactory = t.createCallerFactory;

const isEdgeAuthed = t.middleware(async ({ ctx, next }) => {
  const authHeader = ctx.req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ovl_prod_')) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Missing or malformed API key' });
  }

  const rawToken = authHeader.split('Bearer ovl_prod_')[1];
  const tokenLookupHash = crypto.createHash('sha256').update(rawToken.substring(0, 8)).digest('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  // We can't access `this.db` directly here because it's inside the TrpcRouter class.
  // We will pass the db to the middleware inside the router class!
  return next({
    ctx: {
      ...ctx,
      tokenHash,
      tokenLookupHash,
    },
  });
});

export const edgeProcedure = t.procedure.use(isEdgeAuthed);

/**
 * Verifies the SuperTokens session on the underlying Express req/res
 * (mirrors AuthGuard's REST-side check — the tRPC router is mounted via raw
 * app.use(), so Nest's @UseGuards() never runs for it; this is the only
 * place session verification happens for tRPC traffic).
 *
 * Deliberately uses Session.getSession() (the plain function), not the
 * verifySession() Express middleware: verifySession() is designed to be a
 * terminal middleware and writes a 401 response directly to `res` on
 * failure, which crashes the server here ("write after end") since tRPC's
 * Express adapter also tries to write a response to the same `res` once
 * this middleware throws. getSession() just throws without touching `res`.
 *
 * Loading the full local Postgres user (for role checks) happens
 * per-procedure via the injected SupertokensService, not here, since this
 * middleware is defined at module scope before DI has constructed it.
 */
const isAuthed = t.middleware(async ({ ctx, next }) => {
  try {
    const session = await Session.getSession(ctx.req, ctx.res);
    return next({ ctx: { ...ctx, session } });
  } catch {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not logged in' });
  }
});

export const protectedProcedure = t.procedure.use(isAuthed);

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
  /**
   * Authenticates an edge (vessel) caller. Every edge procedure must call this.
   *
   * The `isEdgeAuthed` middleware only parses the bearer token and derives its
   * hashes — it never checks them against anything, as its own comment admits
   * ("we will pass the db to the middleware inside the router class"). That was
   * only ever done inside `enroll`, so `pushEvents` and `pullConfig` accepted
   * any string beginning with `ovl_prod_`: an unauthenticated caller could push
   * report versions for any vessel id and read back that vessel's config, chat
   * and remarks. A contract test caught it.
   *
   * Verification happens where the keys actually live. With tenancy enabled
   * that is the tenant's own schema, reached through the platform pointer — the
   * lookup hash selects a schema, the full token hash authenticates. Without
   * tenancy it falls back to the shared table, so a single-tenant deployment
   * gets the same check rather than staying on the unverified path.
   */
  private async authenticateEdge(ctx: {
    tokenLookupHash: string;
    tokenHash: string;
  }): Promise<void> {
    const unauthorized = new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Invalid or revoked API key',
    });

    if (this.edgeTenants && this.tenantDb) {
      const tenant = await this.edgeTenants.resolve(ctx.tokenLookupHash);
      if (!tenant) throw unauthorized;
      await runAsSystemForTenant({ ...tenant, requestId: 'edge-auth' }, () =>
        this.assertEdgeKeyValid(ctx.tokenHash),
      );
      return;
    }

    const keys = await this.db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.tokenLookupHash, ctx.tokenLookupHash));

    if (keys.length === 0 || keys[0].tokenHash !== ctx.tokenHash || keys[0].revokedAt) {
      throw unauthorized;
    }
  }

  private async assertEdgeKeyValid(tokenHash: string): Promise<void> {
    const valid = await this.requireCatalogue(this.tenantDb).withTenant(
      async (db) => {
        const rows = await db
          .select()
          .from(schema.apiKeys)
          .where(eq(schema.apiKeys.tokenHash, tokenHash))
          .limit(1);
        return rows.length > 0 && !rows[0].revokedAt;
      },
      { readOnly: true },
    );

    if (!valid) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Unknown API key' });
    }
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

  /**
   * Re-checks every report in (vesselId, schemaName)'s chain against the
   * continuity rules (architecture 8.3) after a report version lands —
   * ports office/syncservice/cascade.go's runCascade near-verbatim. Any
   * newly (or differently) broken report flips to state "invalidated",
   * gets an audit event, and gets an invalidation_notices row for the
   * vessel to later pull. A cascade failure must not reject the outbox
   * item that already landed successfully — callers should log and
   * continue, matching PushOutbox's own "the item is accepted" contract.
   */
  private async runCascade(vesselId: string, schemaName: string): Promise<void> {
    // ListChain: the latest version of every report for (vesselId,
    // schemaName), ascending by event time — corrections replace their
    // earlier version in the chain rather than adding a second entry.
    const allVersions = await this.db
      .select()
      .from(schema.reportVersions)
      .where(and(eq(schema.reportVersions.vesselId, vesselId), eq(schema.reportVersions.schemaKind, schemaName)));

    const latestByReportId = new Map<string, typeof allVersions[number]>();
    for (const r of allVersions) {
      const existing = latestByReportId.get(r.reportId);
      if (!existing || r.versionNo > existing.versionNo) latestByReportId.set(r.reportId, r);
    }
    // The office should never hold a draft/ready row in the first place
    // (nothing is enqueued before submit), so this is a guard, not a
    // real behavior change — kept for parity with the original's own
    // filter, since both sides must compute cascade over the same chain.
    const chainRows = Array.from(latestByReportId.values()).filter((r) => r.state !== 'draft' && r.state !== 'ready');

    // schemaKind is stored as the vessel's own schema-id convention
    // (e.g. "bunker-report.json") — stripped only here, for resolving
    // the continuity config, same normalization FieldPolicyService
    // already does; the chain query above must keep matching the
    // column's actual stored form.
    const bareSchemaName = schemaName.replace(/\.json$/, '');

    const chain: ContinuityReport[] = chainRows.map((r) => ({
      reportId: r.reportId,
      versionNo: r.versionNo,
      schemaName: bareSchemaName,
      eventType: r.eventType,
      eventTime: new Date(r.eventTime),
      fields: (r.fields as Record<string, unknown>) || {},
    }));

    const vesselRows = await this.db.select().from(schema.vessels).where(eq(schema.vessels.id, vesselId)).limit(1);
    const vesselGroups = (vesselRows[0]?.groups as string[] | null) ?? [];

    const assignments = await this.complianceService.listRuleSeverities();
    const cfg = continuityConfigFor(bareSchemaName);
    cfg.severities = effectiveSeverities(assignments, vesselId, vesselGroups) as Record<string, Severity>;

    const result = revalidate(chain, cfg);
    const now = new Date().toISOString();

    for (const row of chainRows) {
      const brokenRules = result.invalidated.get(row.reportId);
      if (!brokenRules || brokenRules.length === 0) continue;

      if (row.state === 'invalidated') {
        const prevNotice = await this.db
          .select()
          .from(schema.invalidationNotices)
          .where(and(eq(schema.invalidationNotices.vesselId, vesselId), eq(schema.invalidationNotices.reportId, row.reportId), eq(schema.invalidationNotices.versionNo, row.versionNo)))
          .orderBy(desc(schema.invalidationNotices.seq))
          .limit(1);
        const prevRules = (prevNotice[0]?.brokenRules as string[] | undefined) ?? [];
        if (prevRules.length === brokenRules.length && prevRules.every((r, i) => r === brokenRules[i])) {
          continue; // already recorded with the same broken rules
        }
      }

      await this.db
        .update(schema.reportVersions)
        .set({ state: 'invalidated' })
        .where(and(eq(schema.reportVersions.vesselId, vesselId), eq(schema.reportVersions.reportId, row.reportId), eq(schema.reportVersions.versionNo, row.versionNo)));

      await this.db.insert(schema.reportAuditEvents).values({
        vesselId,
        reportId: row.reportId,
        versionNo: row.versionNo,
        eventType: 'invalidated',
        actor: '',
        occurredAt: now,
        detail: { brokenRules, fromState: row.state },
        receivedAt: now,
        origin: 'office',
      });

      await this.db.insert(schema.invalidationNotices).values({
        vesselId,
        reportId: row.reportId,
        versionNo: row.versionNo,
        brokenRules,
        computedAt: now,
      });
    }
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

    edge: router({
      enroll: edgeProcedure
        .input((val: unknown) => {
          if (!EnrollEdgeCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof EnrollEdgeSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          // 1. Verify the API key.
          //
          // Two steps, because api_keys now lives inside a tenant schema: the
          // platform index says which tenant to look in, and only then is the
          // full token hash checked against that tenant's own keys. The lookup
          // hash is a pointer, never a credential.
          const resolver = this.requireCatalogue(this.edgeTenants);
          const tenant = await resolver.resolve(ctx.tokenLookupHash);
          if (!tenant) {
            throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid or revoked API key' });
          }
          await runAsSystemForTenant({ ...tenant, requestId: 'edge-enroll' }, () =>
            this.assertEdgeKeyValid(ctx.tokenHash),
          );

          // 2. The vessel row itself is still created on the legacy shared
          // connection, because pullConfig and pushEvents have not moved yet
          // and would not find it in a tenant schema. This is the coexistence
          // seam, and it moves when the sync path does.

          // Lookup Vessel by IMO
          const existing = await this.db.select().from(schema.vessels).where(eq(schema.vessels.imo, input.imoNumber));
          
          let vesselId;
          if (existing.length > 0) {
            vesselId = existing[0].id;
          } else {
            // Create implicitly
            const newVessel = await this.db.insert(schema.vessels).values({
              name: input.vesselName,
              imo: input.imoNumber,
              type: 'Cargo', // Default
              groups: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }).returning();
            vesselId = newVessel[0].id;
          }

          return { vesselId };
        }),
    }),

    sync: router({
      pushEvents: edgeProcedure
        .input((val: unknown) => {
          if (!PushEventsCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof PushEventsSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          await this.authenticateEdge(ctx);
          console.log(`Office received ${input.events.length} events from vessel ${input.vesselId}`);

          await this.db.insert(schema.vesselSyncStatus)
            .values({ vesselId: input.vesselId, lastSeenAt: new Date().toISOString() })
            .onConflictDoUpdate({
              target: schema.vesselSyncStatus.vesselId,
              set: { lastSeenAt: new Date().toISOString() },
            });

          for (const event of input.events) {
            if (event.eventType === 'report_submitted') {
              try {
                const payload = JSON.parse(event.payload);
                await this.db.insert(schema.reportVersions).values({
                  vesselId: input.vesselId,
                  reportId: payload.reportId,
                  versionNo: payload.versionNo,
                  schemaKind: payload.schemaName || 'unknown',
                  schemaVersion: '1.0',
                  eventType: payload.eventType || 'ReportSubmitted',
                  state: payload.state || 'submitted',
                  eventTime: payload.eventTime || new Date().toISOString(),
                  fields: payload.fields || {},
                  submittedAt: payload.submittedAt || new Date().toISOString(),
                  receivedAt: new Date().toISOString(),
                });
                
                await this.db.insert(schema.reportAuditEvents).values({
                  vesselId: input.vesselId,
                  reportId: payload.reportId,
                  versionNo: payload.versionNo,
                  eventType: 'submitted',
                  actor: payload.submittedBy || 'vessel_master',
                  occurredAt: payload.submittedAt || new Date().toISOString(),
                  detail: {},
                  receivedAt: new Date().toISOString(),
                  origin: 'vessel',
                });

                // Cascade revalidation (architecture 8.3) runs
                // synchronously right after landing, so a dependent
                // later report's invalidation is visible within this
                // same push call. A failure here must not reject an
                // item that already landed successfully. Passed as
                // stored (schema_kind carries the vessel's own
                // "bunker-report.json"-style id, .json suffix and all)
                // — runCascade strips it only where it actually matters
                // (resolving the continuity config), not for the chain
                // query itself, which must match what's in the column.
                try {
                  await this.runCascade(input.vesselId, payload.schemaName || 'unknown');
                } catch (err: any) {
                  console.error(`Cascade revalidation failed for vessel ${input.vesselId}:`, err);
                }
              } catch (err: any) {
                console.error('Failed to parse or save report event:', err);
              }
            } else if (event.eventType === 'chat_sent') {
              try {
                const payload = JSON.parse(event.payload);
                // chat_messages.direction is constrained to 'vessel'/'office'
                // (this table's schema mirrors the original Go domain's
                // ChatDirection values) — the vessel's own local SQLite
                // convention is 'ship_to_shore'/'shore_to_ship' (already
                // baked into its schema and UI), so every message is
                // translated at this sync boundary rather than picking one
                // convention and forcing it on both sides.
                await this.db.insert(schema.chatMessages).values({
                  id: payload.id,
                  vesselId: input.vesselId,
                  reportId: payload.reportId,
                  sender: payload.sender,
                  body: payload.body,
                  sentAt: payload.sentAt || new Date().toISOString(),
                  direction: 'vessel',
                }).onConflictDoNothing();
              } catch (err: any) {
                console.error('Failed to parse or save chat message:', err);
              }
            } else if (event.eventType === 'correction_started') {
              // Architecture 8.1/8.2's "Start correction" — the vessel
              // already has version N+1 as a new local draft; this only
              // records the audit trail entry against the *old* version
              // office already has (mirrors pkg/domain.Report.NewCorrection's
              // own event placement). The new draft itself lands later,
              // as its own ordinary report_submitted push once the
              // vessel actually submits it.
              try {
                const payload = JSON.parse(event.payload);
                await this.db.insert(schema.reportAuditEvents).values({
                  vesselId: input.vesselId,
                  reportId: payload.reportId,
                  versionNo: payload.versionNo,
                  eventType: 'correction_started',
                  actor: payload.actor,
                  occurredAt: payload.at || new Date().toISOString(),
                  detail: { newVersionNo: payload.newVersionNo },
                  receivedAt: new Date().toISOString(),
                  origin: 'vessel',
                });
              } catch (err: any) {
                console.error('Failed to parse or save correction_started event:', err);
              }
            } else {
              console.warn(`Unrecognized outbox eventType "${event.eventType}" from vessel ${input.vesselId} — dropped.`);
            }
          }
          
          return {
            success: true,
            processedCount: input.events.length,
          };
        }),

      pullConfig: edgeProcedure
        .input((val: unknown) => {
          if (!PullConfigInputCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof PullConfigInputSchema>;
        })
        .query(async ({ input, ctx }) => {
          await this.authenticateEdge(ctx);
          const bundle = await this.configBundleService.resolveForVessel(input.vesselId);
          const syncedAt = new Date().toISOString();

          await this.db.insert(schema.vesselSyncStatus)
            .values({
              vesselId: input.vesselId,
              lastSeenAt: syncedAt,
              appliedBundleId: bundle?.bundleId ?? '',
              appliedBundleVersion: bundle?.versionNo ?? 0,
            })
            .onConflictDoUpdate({
              target: schema.vesselSyncStatus.vesselId,
              set: {
                lastSeenAt: syncedAt,
                appliedBundleId: bundle?.bundleId ?? '',
                appliedBundleVersion: bundle?.versionNo ?? 0,
              },
            });

          // Piggybacked on this same check-in rather than a dedicated RPC —
          // see VesselUsersService.handleCheckIn's own comment.
          const userCommands = await this.vesselUsersService.handleCheckIn(
            input.vesselId,
            input.users,
            input.appliedUserCommandIds,
          );

          // Chat's pull-down half: office-authored messages this vessel
          // hasn't seen yet, by seq cursor. The vessel's own messages
          // already arrived via pushEvents' chat_sent handling — this
          // only needs to carry the other direction back down. Storage
          // uses 'office'/'vessel' (this table's CHECK constraint); the
          // vessel's local convention is 'ship_to_shore'/'shore_to_ship',
          // so direction is translated here at the sync boundary.
          const lastChatSeq = input.lastChatSeq ? BigInt(input.lastChatSeq) : BigInt(0);
          const newChatRows = await this.db
            .select()
            .from(schema.chatMessages)
            .where(
              and(
                eq(schema.chatMessages.vesselId, input.vesselId),
                eq(schema.chatMessages.direction, 'office'),
                gt(schema.chatMessages.seq, lastChatSeq),
              ),
            )
            .orderBy(schema.chatMessages.seq);
          const chatMessages = newChatRows.map((m) => ({ ...m, seq: m.seq.toString(), direction: 'shore_to_ship' }));

          // Remarks' pull-down half, same seq-cursor shape as chat —
          // remarks are always office-authored, so there's no push
          // direction to handle.
          const lastRemarkSeq = input.lastRemarkSeq ? BigInt(input.lastRemarkSeq) : BigInt(0);
          const newRemarkRows = await this.db
            .select()
            .from(schema.remarks)
            .where(and(eq(schema.remarks.vesselId, input.vesselId), gt(schema.remarks.seq, lastRemarkSeq)))
            .orderBy(schema.remarks.seq);
          const remarks = newRemarkRows.map((r) => ({ ...r, seq: r.seq.toString() }));

          // Invalidation notices' pull-down half, same seq-cursor shape
          // — computed office-side only (cascade revalidation), no
          // upstream direction.
          const lastInvalidationSeq = input.lastInvalidationSeq ? BigInt(input.lastInvalidationSeq) : BigInt(0);
          const newInvalidationRows = await this.db
            .select()
            .from(schema.invalidationNotices)
            .where(and(eq(schema.invalidationNotices.vesselId, input.vesselId), gt(schema.invalidationNotices.seq, lastInvalidationSeq)))
            .orderBy(schema.invalidationNotices.seq);
          const invalidationNotices = newInvalidationRows.map((n) => ({ ...n, seq: n.seq.toString() }));

          return {
            bundle,
            syncedAt,
            userCommands,
            chatMessages,
            remarks,
            invalidationNotices,
          };
        }),
    }),
    vessels: router({
      list: protectedProcedure.query(async () => {
        const rows = await this.db.select({
          vessel: schema.vessels,
          lastSeenAt: schema.vesselSyncStatus.lastSeenAt,
        })
          .from(schema.vessels)
          .leftJoin(schema.vesselSyncStatus, eq(schema.vesselSyncStatus.vesselId, schema.vessels.id));

        const now = Date.now();

        return rows.map(({ vessel: v, lastSeenAt }) => {
          const lastSeenMs = lastSeenAt ? new Date(lastSeenAt).getTime() : null;
          return {
            id: v.id,
            name: v.name,
            imo: v.imo,
            type: v.type,
            status: 'At Sea',
            edgeStatus: lastSeenMs === null ? 'Offline' : (now - lastSeenMs <= ONLINE_THRESHOLD_MS ? 'Online' : 'Offline'),
            lastSync: lastSeenAt ? formatRelativeTime(lastSeenMs!) : 'Never',
            groups: v.groups,
          };
        });
      }),
      // Fleet Map (ports ovl/office/httpapi/vesselpositions.go). See
      // VesselsService.getPositions's own doc comment for the full
      // status-precedence and position-parsing rules.
      positions: protectedProcedure
        .input((val: unknown) => {
          if (!ListVesselPositionsCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof ListVesselPositionsSchema>;
        })
        .query(({ input }) => this.vesselsService.getPositions(input.group)),
      create: protectedProcedure
        .input((val: unknown) => {
          if (!CreateVesselCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof CreateVesselSchema>;
        })
        .mutation(async ({ input }) => {
          const newVessel = await this.db.insert(schema.vessels).values({
            name: input.name,
            imo: input.imo,
            type: input.type,
            groups: input.groups || [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }).returning();
          return newVessel[0];
        }),
      update: protectedProcedure
        .input((val: unknown) => {
          if (!UpdateVesselCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof UpdateVesselSchema>;
        })
        .mutation(async ({ input }) => {
          const { id, ...updates } = input;
          const updatedVessel = await this.db.update(schema.vessels).set({
            ...updates,
            updatedAt: new Date().toISOString(),
          }).where(eq(schema.vessels.id, id)).returning();
          return updatedVessel[0];
        }),
      delete: protectedProcedure
        .input((val: unknown) => {
          if (!DeleteVesselCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof DeleteVesselSchema>;
        })
        .mutation(async ({ input }) => {
          await this.db.delete(schema.vessels).where(eq(schema.vessels.id, input.id));
          return { success: true };
        }),
      // Groups are free-form JSONB tags on vessels.groups (architecture
      // 12.4), not a first-class entity — no dedicated groups table, by
      // design (ports ovl/office/httpapi/vesselgroups.go exactly,
      // including its own reasoning for why one hasn't been introduced).
      // The group catalog itself is just the union of every vessel's own
      // groups array (vessels.list already returns it) — rename/delete
      // below mutate that array directly, one vessel row at a time.
      renameGroup: protectedProcedure
        .input((val: unknown) => {
          if (!RenameVesselGroupCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof RenameVesselGroupSchema>;
        })
        .mutation(async ({ input }) => {
          if (!input.from || !input.to) throw new TRPCError({ code: 'BAD_REQUEST', message: 'from and to are both required' });
          const all = await this.db.select({ id: schema.vessels.id, groups: schema.vessels.groups }).from(schema.vessels);
          let updated = 0;
          for (const v of all) {
            const groups = (v.groups as string[]) ?? [];
            if (!groups.includes(input.from)) continue;
            const next = groups.map((g) => (g === input.from ? input.to : g));
            await this.db.update(schema.vessels).set({ groups: next, updatedAt: new Date().toISOString() }).where(eq(schema.vessels.id, v.id));
            updated++;
          }
          return { vesselsUpdated: updated };
        }),
      deleteGroup: protectedProcedure
        .input((val: unknown) => {
          if (!DeleteVesselGroupCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof DeleteVesselGroupSchema>;
        })
        .mutation(async ({ input }) => {
          if (!input.group) throw new TRPCError({ code: 'BAD_REQUEST', message: 'group is required' });
          const all = await this.db.select({ id: schema.vessels.id, groups: schema.vessels.groups }).from(schema.vessels);
          let updated = 0;
          for (const v of all) {
            const groups = (v.groups as string[]) ?? [];
            if (!groups.includes(input.group)) continue;
            const next = groups.filter((g) => g !== input.group);
            await this.db.update(schema.vessels).set({ groups: next, updatedAt: new Date().toISOString() }).where(eq(schema.vessels.id, v.id));
            updated++;
          }
          return { vesselsUpdated: updated };
        }),
      // Remote vessel-user administration (architecture 9.3/12.4) — see
      // VesselUsersService's own doc comment for the full design. Every
      // mutation here queues a command the vessel applies on its own next
      // sync cycle; nothing here writes to the vessel's local user table
      // directly, since it may be offline for hours or days.
      users: router({
        list: protectedProcedure
          .input((val: unknown) => {
            if (!VesselIdInputCompiler.Check(val)) throw new Error('Invalid input');
            return val as Static<typeof VesselIdInputSchema>;
          })
          .query(({ input }) => this.vesselUsersService.listRoster(input.vesselId)),
        listCommands: protectedProcedure
          .input((val: unknown) => {
            if (!VesselIdInputCompiler.Check(val)) throw new Error('Invalid input');
            return val as Static<typeof VesselIdInputSchema>;
          })
          .query(({ input }) => this.vesselUsersService.listCommands(input.vesselId)),
        create: protectedProcedure
          .input((val: unknown) => {
            if (!QueueCreateUserCompiler.Check(val)) throw new Error('Invalid input');
            return val as Static<typeof QueueCreateUserSchema>;
          })
          .mutation(async ({ input, ctx }) => {
            const localUser = await this.supertokensService.getLocalUser(ctx.session.getUserId());
            const issuedBy = localUser?.username || 'office';
            return this.vesselUsersService.queueCreate(input.vesselId, input.username, input.role, issuedBy);
          }),
        resetPassword: protectedProcedure
          .input((val: unknown) => {
            if (!QueueUsernameActionCompiler.Check(val)) throw new Error('Invalid input');
            return val as Static<typeof QueueUsernameActionSchema>;
          })
          .mutation(async ({ input, ctx }) => {
            const localUser = await this.supertokensService.getLocalUser(ctx.session.getUserId());
            const issuedBy = localUser?.username || 'office';
            return this.vesselUsersService.queueResetPassword(input.vesselId, input.username, issuedBy);
          }),
        setRole: protectedProcedure
          .input((val: unknown) => {
            if (!QueueSetRoleCompiler.Check(val)) throw new Error('Invalid input');
            return val as Static<typeof QueueSetRoleSchema>;
          })
          .mutation(async ({ input, ctx }) => {
            const localUser = await this.supertokensService.getLocalUser(ctx.session.getUserId());
            const issuedBy = localUser?.username || 'office';
            return this.vesselUsersService.queueSetRole(input.vesselId, input.username, input.role, issuedBy);
          }),
        setActive: protectedProcedure
          .input((val: unknown) => {
            if (!QueueSetActiveCompiler.Check(val)) throw new Error('Invalid input');
            return val as Static<typeof QueueSetActiveSchema>;
          })
          .mutation(async ({ input, ctx }) => {
            const localUser = await this.supertokensService.getLocalUser(ctx.session.getUserId());
            const issuedBy = localUser?.username || 'office';
            return this.vesselUsersService.queueSetActive(input.vesselId, input.username, input.active, issuedBy);
          }),
        setCanSubmit: protectedProcedure
          .input((val: unknown) => {
            if (!QueueSetCanSubmitCompiler.Check(val)) throw new Error('Invalid input');
            return val as Static<typeof QueueSetCanSubmitSchema>;
          })
          .mutation(async ({ input, ctx }) => {
            const localUser = await this.supertokensService.getLocalUser(ctx.session.getUserId());
            const issuedBy = localUser?.username || 'office';
            return this.vesselUsersService.queueSetCanSubmit(input.vesselId, input.username, input.canSubmit, issuedBy);
          }),
      }),
    }),
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
          const existing = await this.db.select({ id: schema.users.id }).from(schema.users).limit(1);
          if (existing.length > 0) {
            const session = await Session.getSession(ctx.req, ctx.res, { sessionRequired: false }).catch(() => undefined);
            const localUser = session ? await this.supertokensService.getLocalUser(session.getUserId()) : null;
            if (!localUser || !(localUser.roles as string[]).includes('admin')) {
              throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Admin login required to create additional users.' });
            }
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
    reports: router({
      list: protectedProcedure.query(async () => {
        const reports = await this.db
          .select({
            id: schema.reportVersions.reportId,
            vesselId: schema.reportVersions.vesselId,
            versionNo: schema.reportVersions.versionNo,
            type: schema.reportVersions.eventType,
            status: schema.reportVersions.state,
            date: schema.reportVersions.receivedAt,
            vesselName: schema.vessels.name,
            vesselImo: schema.vessels.imo,
            reviewedBy: schema.reportReviews.reviewedBy,
          })
          .from(schema.reportVersions)
          .leftJoin(schema.vessels, eq(schema.reportVersions.vesselId, schema.vessels.id))
          .leftJoin(
            schema.reportReviews,
            and(
              eq(schema.reportReviews.vesselId, schema.reportVersions.vesselId),
              eq(schema.reportReviews.reportId, schema.reportVersions.reportId),
            ),
          );

        // Corrections (Report.startCorrection) mean a reportId can now
        // have more than one row here — keep only the highest versionNo
        // per reportId, so a corrected report shows once, as its current
        // state, not once per historical version.
        const latestByReportId = new Map<string, typeof reports[number]>();
        for (const r of reports) {
          const existing = latestByReportId.get(r.id);
          if (!existing || r.versionNo > existing.versionNo) latestByReportId.set(r.id, r);
        }

        return Array.from(latestByReportId.values())
          .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
          .slice(0, 100)
          .map(r => ({
            id: r.id,
            vessel: r.vesselName || 'Unknown',
            imo: r.vesselImo || 'Unknown',
            type: r.type,
            status: r.status,
            date: new Date(r.date).toISOString().split('T')[0],
            by: 'System',
            reviewed: !!r.reviewedBy,
          }));
      }),
      // The original's own CSV export (office/httpapi/csvexport.go) is
      // API-key-gated for external/compliance tooling, not a dashboard
      // button — it has no UI trigger anywhere in the original app. This
      // is the session-authenticated equivalent of what a user clicking
      // "Export Report" would actually expect: the full ledger (not
      // capped at 100 rows like the list view) as a CSV, returned as
      // text rather than a file download since this app's session
      // transport is header-based (getTokenTransferMethod: 'header') —
      // a plain <a href> or window.open download couldn't carry the
      // auth header, but the tRPC client's fetch already does.
      exportCsv: protectedProcedure.query(async () => {
        const reports = await this.db
          .select({
            id: schema.reportVersions.reportId,
            versionNo: schema.reportVersions.versionNo,
            type: schema.reportVersions.eventType,
            status: schema.reportVersions.state,
            date: schema.reportVersions.receivedAt,
            vesselName: schema.vessels.name,
            vesselImo: schema.vessels.imo,
            reviewedBy: schema.reportReviews.reviewedBy,
          })
          .from(schema.reportVersions)
          .leftJoin(schema.vessels, eq(schema.reportVersions.vesselId, schema.vessels.id))
          .leftJoin(
            schema.reportReviews,
            and(
              eq(schema.reportReviews.vesselId, schema.reportVersions.vesselId),
              eq(schema.reportReviews.reportId, schema.reportVersions.reportId),
            ),
          );

        const latestByReportId = new Map<string, typeof reports[number]>();
        for (const r of reports) {
          const existing = latestByReportId.get(r.id);
          if (!existing || r.versionNo > existing.versionNo) latestByReportId.set(r.id, r);
        }

        const rows = Array.from(latestByReportId.values()).sort(
          (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
        );

        const escapeCsv = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
        const header = ['Report ID', 'Vessel', 'IMO', 'Type', 'Status', 'Date Received', 'Reviewed'];
        const lines = [header.join(',')];
        for (const r of rows) {
          lines.push(
            [
              r.id,
              r.vesselName || 'Unknown',
              r.vesselImo || 'Unknown',
              r.type,
              r.status,
              new Date(r.date).toISOString().split('T')[0],
              r.reviewedBy ? 'Yes' : 'No',
            ]
              .map((v) => escapeCsv(String(v)))
              .join(','),
          );
        }

        return { csv: lines.join('\n'), filename: `fleet-reports-${new Date().toISOString().split('T')[0]}.csv` };
      }),
      get: protectedProcedure
        .input((val: unknown) => {
          if (!GetReportCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof GetReportSchema>;
        })
        .query(async ({ input }) => {
          const report = await this.db
            .select({
              id: schema.reportVersions.reportId,
              vesselId: schema.reportVersions.vesselId,
              versionNo: schema.reportVersions.versionNo,
              type: schema.reportVersions.eventType,
              schemaKind: schema.reportVersions.schemaKind,
              status: schema.reportVersions.state,
              date: schema.reportVersions.receivedAt,
              fields: schema.reportVersions.fields,
              vesselName: schema.vessels.name,
              vesselImo: schema.vessels.imo,
            })
            .from(schema.reportVersions)
            .leftJoin(schema.vessels, eq(schema.reportVersions.vesselId, schema.vessels.id))
            .where(eq(schema.reportVersions.reportId, input.reportId))
            .orderBy(desc(schema.reportVersions.versionNo))
            .limit(1);

          if (!report.length) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' });
          }

          const r = report[0];

          // Specifically the submit event, not just "whatever audit event
          // happened most recently" — a report can pick up later event
          // types (remarked, invalidated, ...) against the same
          // reportId+versionNo, and the most recent one isn't necessarily
          // who submitted it. Found via Remarks: after a Reviewer flagged
          // a field, this used to relabel "Submitted By" as the Reviewer.
          const submitEvent = await this.db
            .select({ actor: schema.reportAuditEvents.actor })
            .from(schema.reportAuditEvents)
            .where(
              and(
                eq(schema.reportAuditEvents.reportId, r.id),
                eq(schema.reportAuditEvents.versionNo, r.versionNo),
                eq(schema.reportAuditEvents.eventType, 'submitted'),
              ),
            )
            .orderBy(desc(schema.reportAuditEvents.occurredAt))
            .limit(1);

          const review = await this.db
            .select({ reviewedBy: schema.reportReviews.reviewedBy, reviewedAt: schema.reportReviews.reviewedAt })
            .from(schema.reportReviews)
            .where(
              and(
                eq(schema.reportReviews.vesselId, r.vesselId),
                eq(schema.reportReviews.reportId, r.id),
              ),
            )
            .limit(1);

          // report_versions carries no invalidatedRules column of its
          // own (unlike the vessel's local schema) — the
          // invalidation_notices log is the source of truth, so the
          // latest one for this exact version is looked up only when
          // actually needed for display.
          let brokenRules: string[] | null = null;
          if (r.status === 'invalidated') {
            const notice = await this.db
              .select({ brokenRules: schema.invalidationNotices.brokenRules })
              .from(schema.invalidationNotices)
              .where(
                and(
                  eq(schema.invalidationNotices.vesselId, r.vesselId),
                  eq(schema.invalidationNotices.reportId, r.id),
                  eq(schema.invalidationNotices.versionNo, r.versionNo),
                ),
              )
              .orderBy(desc(schema.invalidationNotices.seq))
              .limit(1);
            brokenRules = (notice[0]?.brokenRules as string[] | undefined) ?? null;
          }

          return {
            id: r.id,
            vesselId: r.vesselId,
            type: r.type,
            schemaKind: r.schemaKind,
            vessel: r.vesselName || 'Unknown',
            imo: r.vesselImo || 'Unknown',
            status: r.status,
            submittedAt: r.date,
            author: submitEvent[0]?.actor || 'System',
            fields: (r.fields || {}) as Record<string, any>,
            reviewed: review.length > 0,
            reviewedBy: review[0]?.reviewedBy ?? null,
            reviewedAt: review[0]?.reviewedAt ?? null,
            brokenRules,
          };
        }),
      // Mirrors the original OVL product's reviewer workflow: office staff can
      // mark a report as looked-at ("triage"), which is a bookkeeping flag,
      // not a state transition — there is no approve/reject concept for
      // reports in the source product (see office/store/reportreviews.go).
      markReviewed: protectedProcedure
        .input((val: unknown) => {
          if (!MarkReviewedCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof MarkReviewedSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          const latest = await this.db
            .select({ vesselId: schema.reportVersions.vesselId })
            .from(schema.reportVersions)
            .where(eq(schema.reportVersions.reportId, input.reportId))
            .limit(1);
          if (!latest.length) throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' });
          const vesselId = latest[0].vesselId;

          const localUser = await this.supertokensService.getLocalUser(ctx.session.getUserId());
          const reviewedBy = localUser?.username || 'unknown';

          await this.db
            .insert(schema.reportReviews)
            .values({
              vesselId,
              reportId: input.reportId,
              reviewedBy,
              reviewedAt: new Date().toISOString(),
            })
            .onConflictDoUpdate({
              target: [schema.reportReviews.vesselId, schema.reportReviews.reportId],
              set: { reviewedBy, reviewedAt: new Date().toISOString() },
            });

          return { reviewed: true, reviewedBy };
        }),
      // Architecture 12.3/design handoff B4's per-report chat wall —
      // mirrors the vessel side's reports.getChat/sendChatMessage
      // (apps/api-vessel/src/reports/reports.service.ts) so both apps
      // expose the same shape. Chat is viewable/sendable by any
      // authenticated office user, same as the original (not
      // Reviewer-gated the way remarks are).
      getChat: protectedProcedure
        .input((val: unknown) => {
          if (!GetChatCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof GetChatSchema>;
        })
        .query(async ({ input }) => {
          const rows = await this.db
            .select()
            .from(schema.chatMessages)
            .where(eq(schema.chatMessages.reportId, input.reportId))
            .orderBy(schema.chatMessages.sentAt);
          return rows.map((m) => ({ ...m, seq: m.seq.toString() }));
        }),
      sendChatMessage: protectedProcedure
        .input((val: unknown) => {
          if (!SendChatMessageCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof SendChatMessageSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          if (Buffer.byteLength(input.body, 'utf8') > MAX_CHAT_BODY_BYTES) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: `Chat message body exceeds the ${MAX_CHAT_BODY_BYTES} byte limit.` });
          }
          const latest = await this.db
            .select({ vesselId: schema.reportVersions.vesselId })
            .from(schema.reportVersions)
            .where(eq(schema.reportVersions.reportId, input.reportId))
            .limit(1);
          if (!latest.length) throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' });

          const localUser = await this.supertokensService.getLocalUser(ctx.session.getUserId());
          const sender = localUser?.username || 'office';

          const rows = await this.db
            .insert(schema.chatMessages)
            .values({
              id: crypto.randomUUID(),
              vesselId: latest[0].vesselId,
              reportId: input.reportId,
              sender,
              body: input.body,
              sentAt: new Date().toISOString(),
              direction: 'office',
            })
            .returning();
          return { ...rows[0], seq: rows[0].seq.toString() };
        }),
      // Design handoff B4's "send remark set" (architecture 12.3): a
      // Reviewer flags one or more fields on the report's latest version
      // with comments, in a single call — mirrors
      // ovl/office/httpapi/remarks.go's handleCreateRemarkSet, minus the
      // human-readable field-label resolution (this port's office side
      // has no schema registry to resolve labels from; the chat summary
      // falls back to raw field names, same as the original does when a
      // schema can't be loaded).
      createRemarkSet: protectedProcedure
        .input((val: unknown) => {
          if (!CreateRemarkSetCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof CreateRemarkSetSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          const localUser = await this.supertokensService.getLocalUser(ctx.session.getUserId());
          if (!localUser || !(localUser.roles as string[]).includes('reviewer')) {
            throw new TRPCError({ code: 'FORBIDDEN', message: 'Only a Reviewer may flag fields with remarks.' });
          }

          const latest = await this.db
            .select({ vesselId: schema.reportVersions.vesselId, versionNo: schema.reportVersions.versionNo, state: schema.reportVersions.state })
            .from(schema.reportVersions)
            .where(eq(schema.reportVersions.reportId, input.reportId))
            .orderBy(desc(schema.reportVersions.versionNo))
            .limit(1);
          if (!latest.length) throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' });
          const { vesselId, versionNo, state } = latest[0];
          // Mirrors pkg/domain.Report.MarkRemarked's own guard: a report
          // still in draft/ready hasn't been submitted for review yet.
          if (state === 'draft' || state === 'ready') {
            throw new TRPCError({ code: 'CONFLICT', message: `Cannot remark a report in state "${state}"; it must be submitted first.` });
          }

          const author = localUser.username;
          const now = new Date().toISOString();
          const remarkSetId = crypto.randomUUID();
          const fieldNames = input.remarks.map((r) => r.fieldName);

          const insertedRemarks = await this.db
            .insert(schema.remarks)
            .values(
              input.remarks.map((r) => ({
                id: crypto.randomUUID(),
                remarkSetId,
                vesselId,
                reportId: input.reportId,
                versionNo,
                fieldName: r.fieldName,
                body: r.body,
                author,
                createdAt: now,
                resolved: false,
              })),
            )
            .returning();

          await this.db
            .update(schema.reportVersions)
            .set({ state: 'remarked' })
            .where(and(eq(schema.reportVersions.vesselId, vesselId), eq(schema.reportVersions.reportId, input.reportId), eq(schema.reportVersions.versionNo, versionNo)));

          await this.db.insert(schema.reportAuditEvents).values({
            vesselId,
            reportId: input.reportId,
            versionNo,
            eventType: 'remarked',
            actor: author,
            occurredAt: now,
            detail: { fields: fieldNames },
            receivedAt: now,
            origin: 'office',
          });

          // Phase 5 restructure: since the standalone Remarks tab is
          // gone client-side, a remark set also auto-posts a linking
          // chat message — otherwise a remark would land with no trace
          // in the surface that replaced it (see reports.sendChatMessage
          // above for the same insert shape).
          const shown = fieldNames.slice(0, 3);
          const suffix = fieldNames.length > 3 ? ` (+${fieldNames.length - 3} more)` : '';
          let summary = `Flagged: ${shown.join(', ')}${suffix}`;
          if (input.remarks.length === 1) summary += `\n${input.remarks[0].body}`;
          if (Buffer.byteLength(summary, 'utf8') > MAX_CHAT_BODY_BYTES) {
            summary = Buffer.from(summary, 'utf8').subarray(0, MAX_CHAT_BODY_BYTES).toString('utf8');
          }
          await this.db.insert(schema.chatMessages).values({
            id: crypto.randomUUID(),
            vesselId,
            reportId: input.reportId,
            sender: author,
            body: summary,
            sentAt: now,
            direction: 'office',
          });

          return insertedRemarks.map((r) => ({ ...r, seq: r.seq.toString() }));
        }),
      listRemarks: protectedProcedure
        .input((val: unknown) => {
          if (!ListRemarksCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof ListRemarksSchema>;
        })
        .query(async ({ input }) => {
          const rows = await this.db
            .select()
            .from(schema.remarks)
            .where(eq(schema.remarks.reportId, input.reportId))
            .orderBy(schema.remarks.createdAt);
          return rows.map((r) => ({ ...r, seq: r.seq.toString() }));
        }),
      // Reviewer-only manual toggle (Phase 5 open question 2's resolved
      // default: no auto-infer from a later synced value).
      setRemarkResolved: protectedProcedure
        .input((val: unknown) => {
          if (!SetRemarkResolvedCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof SetRemarkResolvedSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          const localUser = await this.supertokensService.getLocalUser(ctx.session.getUserId());
          if (!localUser || !(localUser.roles as string[]).includes('reviewer')) {
            throw new TRPCError({ code: 'FORBIDDEN', message: 'Only a Reviewer may resolve remarks.' });
          }
          await this.db
            .update(schema.remarks)
            .set({ resolved: input.resolved, resolvedAt: input.resolved ? new Date().toISOString() : null })
            .where(eq(schema.remarks.id, input.id));
          return { resolved: input.resolved };
        }),
    }),
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
    dashboard: router({
      getOverview: protectedProcedure.query(async () => {
        const activeVesselsResult = await this.db.select({ count: sql<number>`count(*)` }).from(schema.vessels);
        const incomingReportsResult = await this.db.select({ count: sql<number>`count(*)` }).from(schema.reportVersions);

        // Fleet-wide sync health: same "online" definition as the
        // Vessels list's edgeStatus badge (ONLINE_THRESHOLD_MS), rolled
        // up into a fleet-wide percentage. Replaces what used to be a
        // hardcoded 100% "Database Sync" figure with the actual fraction
        // of the fleet that has checked in recently.
        const syncRows = await this.db
          .select({ lastSeenAt: schema.vesselSyncStatus.lastSeenAt })
          .from(schema.vessels)
          .leftJoin(schema.vesselSyncStatus, eq(schema.vesselSyncStatus.vesselId, schema.vessels.id));
        const now = Date.now();
        const onlineCount = syncRows.filter((r) => {
          if (!r.lastSeenAt) return false;
          return now - new Date(r.lastSeenAt).getTime() <= ONLINE_THRESHOLD_MS;
        }).length;
        const vesselsTotal = syncRows.length;
        const syncHealthPercent = vesselsTotal === 0 ? 100 : Math.round((onlineCount / vesselsTotal) * 100);
        const syncWarnings = vesselsTotal - onlineCount;

        const recentEvents = await this.db
          .select({
            eventType: schema.reportAuditEvents.eventType,
            occurredAt: schema.reportAuditEvents.occurredAt,
            vesselName: schema.vessels.name,
          })
          .from(schema.reportAuditEvents)
          .leftJoin(schema.vessels, eq(schema.reportAuditEvents.vesselId, schema.vessels.id))
          .orderBy(desc(schema.reportAuditEvents.occurredAt))
          .limit(10);

        return {
          activeVessels: activeVesselsResult[0].count,
          incomingReports: incomingReportsResult[0].count,
          syncWarnings,
          syncHealthPercent,
          networkUptime: 99.9,
          liveStream: recentEvents.map((e) => ({
            vessel: e.vesselName || 'Unknown',
            event: `Report ${e.eventType}`,
            time: new Date(e.occurredAt).toLocaleString(),
          })),
        };
      })
    }),
    notifications: router({
      // A read-only projection over overdue vessels, recent vessel chat
      // replies, and recent report-landing activity — see
      // NotificationsService's own doc comment for why there's no
      // notifications table backing this. Each user's read-state is
      // private to them (notification_read_state is keyed by user id).
      list: protectedProcedure.query(async ({ ctx }) => {
        // A 401 here (rather than the same graceful-fallback pattern
        // every other localUser lookup in this file uses) gets treated
        // by the frontend's SuperTokens interceptor as "session needs
        // refreshing" globally — not as this endpoint's own concern —
        // which retries the request 10 times against an unrelated
        // failure and then gives up loudly. No local user just means no
        // read-state can be tracked for this session; degrade to
        // showing every notification unread rather than erroring.
        const localUser = await this.supertokensService.getLocalUser(ctx.session.getUserId());
        return this.notificationsService.list(localUser?.id ?? null);
      }),
      markRead: protectedProcedure
        .input((val: unknown) => {
          if (!MarkNotificationsReadCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof MarkNotificationsReadSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          const localUser = await this.supertokensService.getLocalUser(ctx.session.getUserId());
          if (!localUser) return { marked: 0 };
          const marked = await this.notificationsService.markRead(localUser.id, input.ids);
          return { marked };
        }),
    }),
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
    commercial: router({
      list: protectedProcedure
        .input((val: unknown) => {
          if (!ListCommercialReportsCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof ListCommercialReportsSchema>;
        })
        .query(async ({ input }) => {
          const schemaKind = `${input.schemaName}.json`;
          const reports = await this.db
            .select({
              id: schema.reportVersions.reportId,
              vesselId: schema.reportVersions.vesselId,
              versionNo: schema.reportVersions.versionNo,
              type: schema.reportVersions.eventType,
              status: schema.reportVersions.state,
              date: schema.reportVersions.receivedAt,
              vesselName: schema.vessels.name,
              vesselImo: schema.vessels.imo,
            })
            .from(schema.reportVersions)
            .leftJoin(schema.vessels, eq(schema.reportVersions.vesselId, schema.vessels.id))
            .where(eq(schema.reportVersions.schemaKind, schemaKind));

          const latestByReportId = new Map<string, typeof reports[number]>();
          for (const r of reports) {
            const existing = latestByReportId.get(r.id);
            if (!existing || r.versionNo > existing.versionNo) latestByReportId.set(r.id, r);
          }
          return Array.from(latestByReportId.values())
            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
            .map((r) => ({
              id: r.id,
              vesselId: r.vesselId,
              vessel: r.vesselName || 'Unknown',
              imo: r.vesselImo || 'Unknown',
              type: r.type,
              status: r.status,
              date: new Date(r.date).toISOString(),
            }));
        }),
      create: protectedProcedure
        .input((val: unknown) => {
          if (!CreateCommercialReportCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof CreateCommercialReportSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          const localUser = await this.supertokensService.getLocalUser(ctx.session.getUserId());
          if (!localUser || !(localUser.roles as string[]).includes('commercialEditor')) {
            throw new TRPCError({ code: 'FORBIDDEN', message: 'Only Commercial Editor may author commercial data' });
          }
          const label = COMMERCIAL_SCHEMA_LABELS[input.schemaName];
          if (!label) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown commercial schema' });

          const vesselRows = await this.db.select().from(schema.vessels).where(eq(schema.vessels.id, input.vesselId)).limit(1);
          if (!vesselRows[0]) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown vessel' });

          // Real-but-scoped health check: mandatory-field completeness
          // only, not the original's full plausibility/continuity rule
          // engine — this port has no equivalent
          // validation.EvaluatePlausibilityRules to run, and
          // approximating safety rules without it would be worse than
          // not having them (same principled scope cut as the vessel
          // ReportForm's own Health Check panel).
          const schemaFieldsResult = await this.schemaVersionsService.getLatestFields(input.schemaName);
          const knownFields = schemaFieldsResult?.fields ?? [];
          const findings = knownFields
            .filter((f) => f.schemaMandatory && (input.fields[f.name] === undefined || input.fields[f.name] === null || input.fields[f.name] === ''))
            .map((f) => ({ ruleId: 'fieldPolicy.mandatory', severity: 'error' as const, field: f.name, message: `${f.label || f.name} is required` }));

          if (findings.length > 0) {
            return { report: null, findings };
          }

          const reportId = crypto.randomUUID();
          const now = new Date().toISOString();
          const schemaKind = `${input.schemaName}.json`;

          await this.db.insert(schema.reportVersions).values({
            vesselId: input.vesselId,
            reportId,
            versionNo: 1,
            schemaKind,
            schemaVersion: schemaFieldsResult?.version ?? '',
            eventType: label,
            state: 'submitted',
            eventTime: now,
            fields: input.fields,
            submittedAt: now,
            receivedAt: now,
          });

          for (const eventType of ['created', 'ready', 'submitted']) {
            await this.db.insert(schema.reportAuditEvents).values({
              vesselId: input.vesselId,
              reportId,
              versionNo: 1,
              eventType,
              actor: localUser.username,
              occurredAt: now,
              detail: {},
              receivedAt: now,
              origin: 'office',
            });
          }

          return {
            report: { id: reportId, vesselId: input.vesselId, type: label, status: 'submitted' },
            findings: [] as { ruleId: string; severity: 'error' | 'warning'; field?: string; message: string }[],
          };
        }),
    }),
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
