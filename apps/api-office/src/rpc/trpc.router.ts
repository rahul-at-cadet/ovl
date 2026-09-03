import { Injectable, Inject } from '@nestjs/common';
import { initTRPC } from '@trpc/server';
import { Type, Static } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { DATABASE_CONNECTION } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, isNull, desc, sql, and, gt, inArray, type SQL } from 'drizzle-orm';
import * as crypto from 'crypto';
import * as schema from '@ovl/database';

import * as trpcExpress from '@trpc/server/adapters/express';
import { SchemaVersionsService } from '../config/schema-versions/schema-versions.service';
import { FieldPolicyService } from '../config/field-policy/field-policy.service';
import { ComplianceService } from '../config/compliance/compliance.service';
import { ConfigBundleService, type SyncHistoryFilters, type SyncHistorySort } from '../config/config-bundle/config-bundle.service';
import { toIso, toIsoOrNull } from '../common/iso-time';
import { AttachmentsService, type AttachmentMeta } from '../attachments/attachments.service';
import { VesselUsersService } from '../vessels/vessel-users.service';
import { VesselsService } from '../vessels/vessels.service';
import { RestoreBundleService } from '../vessels/restore-bundle.service';
import { Scope } from '../config/logic/scope';
import { effectiveSeverities } from '../config/logic/compliance';
import { continuityConfigFor, revalidate, type ContinuityReport, type Severity } from '../config/logic/continuity';
import { validateImo } from '../vessels/logic/imo';
import { canonicalizeCode, generateEnrollmentCode, isRedeemable, type EnrollmentState } from '../vessels/logic/enrollment';
import * as argon2 from 'argon2';
import { SupertokensService } from '../auth/supertokens.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';
import { UserRole } from '../users/dto/create-user.dto';
import Session from 'supertokens-node/recipe/session';
import { TRPCError } from '@trpc/server';
import { domainErrorMapper } from './domain-error.middleware';
import { isAppError } from '../common/app-error';

/**
 * The check-in log's wire input. Deliberately flat rather than nesting a
 * `filters` object: tRPC infers the client-facing input from this
 * validator's *return* type, so a nested shape here would force every
 * caller to send `{ filters: { ... } }`.
 *
 * Every field is optional and must stay genuinely optional in the
 * inferred type — spelling them as `x: v.x` infers `string | undefined`
 * as a *required* property, which forces callers to pass every filter
 * explicitly. That exact mistake broke the production type check once
 * already, since `next dev` never type-checks and only `next build`
 * catches it.
 */
interface SyncHistoryInput extends SyncHistoryFilters {
  limit: number;
  sort: SyncHistorySort;
  cursor?: { receivedAt: string; id: string };
}

/** Narrows the wire input to just the filtering half. */
function toSyncHistoryFilters(input: SyncHistoryInput): SyncHistoryFilters {
  const { limit: _limit, sort: _sort, cursor: _cursor, ...filters } = input;
  return filters;
}

/**
 * Shared parser for the check-in log and its metrics, so a filter can
 * never mean one thing to the list and another to the summary above it.
 *
 * Hand-written rather than TypeBox because the fields are all optional
 * and must stay genuinely optional in the inferred type — spelling them
 * as `x: v.x` infers `string | undefined` as a *required* property, which
 * forces every caller to pass every filter explicitly. That exact
 * mistake broke the production type check once already, since `next dev`
 * never type-checks and only `next build` catches it.
 */
function parseSyncHistoryInput(val: unknown): SyncHistoryInput {
  const v = (val ?? {}) as {
    vesselId?: string;
    outcomes?: unknown;
    from?: string;
    to?: string;
    search?: string;
    bundleId?: string;
    sort?: string;
    limit?: number;
    cursor?: { receivedAt: string; id: string } | null;
  };

  const parsed: SyncHistoryInput = {
    limit: typeof v.limit === 'number' ? v.limit : 50,
    sort: v.sort === 'oldest' ? 'oldest' : 'newest',
  };
  // Validated here rather than left to Postgres. These land in uuid and
  // timestamptz columns, and a malformed one used to come back as a 500
  // quoting the database's own error.
  if (typeof v.vesselId === 'string' && v.vesselId) {
    if (!UUID_RE.test(v.vesselId)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'vesselId must be a uuid.' });
    parsed.vesselId = v.vesselId;
  }
  if (typeof v.bundleId === 'string' && v.bundleId) {
    if (!UUID_RE.test(v.bundleId)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'bundleId must be a uuid.' });
    parsed.bundleId = v.bundleId;
  }
  if (typeof v.from === 'string' && v.from) parsed.from = parseTimestampFilter(v.from, 'from');
  if (typeof v.to === 'string' && v.to) parsed.to = parseTimestampFilter(v.to, 'to');
  // Trimmed, and dropped when empty: a search box the user has cleared
  // must not narrow to rows containing the empty string.
  const search = typeof v.search === 'string' ? v.search.trim() : '';
  if (search) parsed.search = search;
  if (Array.isArray(v.outcomes)) {
    const outcomes = v.outcomes.filter((o): o is string => typeof o === 'string' && !!o);
    // An empty array means "no filter", not "match nothing" — a chip
    // group with everything deselected should show everything, which is
    // what the user sees when they clear the filter.
    if (outcomes.length > 0) parsed.outcomes = outcomes;
  }
  if (
    v.cursor &&
    typeof v.cursor === 'object' &&
    typeof v.cursor.receivedAt === 'string' &&
    typeof v.cursor.id === 'string'
  ) {
    // A cursor comes back from the client, so a stale bookmark or an
    // edited query string reaches this unaltered — and both halves land
    // in typed columns.
    parseTimestampFilter(v.cursor.receivedAt, 'cursor.receivedAt');
    if (!UUID_RE.test(v.cursor.id)) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'cursor.id must be a uuid.' });
    }
    parsed.cursor = { receivedAt: v.cursor.receivedAt, id: v.cursor.id };
  }
  return parsed;
}

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

/**
 * How stale api_keys.last_used_at is allowed to get before a sync
 * bothers to update it. A vessel checks in every thirty seconds, so
 * writing on every request would put a database write in front of every
 * sync to answer a question nobody needs to the second.
 */
const API_KEY_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Ceiling on one bulk review. Generous enough for a night's reporting
 * across a fleet, low enough that a runaway client cannot ask for a
 * single statement with a hundred thousand parameters in it.
 */
const BULK_REVIEW_LIMIT = 500;

/**
 * A uuid, and a timestamp, as the wire is allowed to carry them.
 *
 * Both exist because a bare Type.String() reaches Postgres unchecked,
 * and Postgres answers a malformed one by throwing. That surfaced as a
 * 500 carrying the database's own message — "invalid input syntax for
 * type uuid" — across nine procedures: a stale bookmark or a hand-edited
 * query string was enough to trigger it, and the reply told the caller
 * about the column type. Validated here, the same input is a 400 that
 * says which field is wrong and nothing about the schema behind it.
 *
 * The timestamp pattern is deliberately stricter than Postgres's parser.
 * Postgres accepts a great deal as a date literal — "yesterday" among
 * them — so an unvalidated filter silently applied a range the caller
 * never asked for and reported success. Requiring ISO-8601 makes a
 * nonsense filter an error rather than a surprise.
 */
const UuidString = () =>
  Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' });

/** Shared by the hand-written parsers, which cannot use a TypeBox schema. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * A timestamp filter the caller actually meant.
 *
 * Two checks, because either alone is insufficient. The shape test keeps
 * out values Postgres would happily reinterpret — it accepts a great deal
 * as a date literal, "yesterday" among them, so an unvalidated filter
 * silently applied a range nobody asked for and reported success. The
 * parse test keeps out values that look right and are not: no pattern
 * can tell that month 13 or day 45 is impossible, and those reached
 * Postgres and threw.
 *
 * The offset is allowed at two or four digits so a value in Postgres's
 * own rendering ("+00") is accepted alongside ISO's ("+00:00").
 */
const TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}(:?\d{2})?)?$/;

function parseTimestampFilter(value: string, field: string): string {
  const bad = () => new TRPCError({ code: 'BAD_REQUEST', message: `${field} must be an ISO-8601 timestamp.` });
  if (!TIMESTAMP_SHAPE.test(value) || Number.isNaN(new Date(value).getTime())) throw bad();

  // The calendar date is checked on its own components rather than by
  // comparing the parsed result back to the input. JavaScript rolls an
  // impossible date forward — 2026-02-30 becomes March 2 — and Postgres
  // rejects it outright, so a value that parses here would still throw
  // there. Comparing the UTC date instead would misfire on a legitimate
  // offset, where the instant genuinely falls on the previous day.
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) throw bad();
  return value;
}

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

const t = initTRPC.context<Context>().create({
  /**
   * Carries a domain error's `details` to the client.
   *
   * errorFormatter cannot change an error's code — that is fixed before
   * it runs, which is why the mapping lives in a middleware — but it can
   * shape the body, which is exactly what is needed here. The validation
   * path attaches field-level errors, and over tRPC they used to be
   * dropped outright: the old mapper read only the summary message, so a
   * form had nothing to render against individual inputs even though the
   * REST side received the full payload.
   */
  errorFormatter({ shape, error }) {
    const cause = error.cause;
    if (isAppError(cause) && cause.details !== undefined) {
      return { ...shape, data: { ...shape.data, details: cause.details } };
    }
    return shape;
  },
});

const PingSchema = Type.Object({ vesselId: Type.String() });
const PingCompiler = TypeCompiler.Compile(PingSchema);

const PushEventsSchema = Type.Object({
  vesselId: UuidString(),
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
  vesselId: UuidString(),
  lastSyncAt: Type.Optional(Type.String()),
  // What the vessel calls itself. Optional so a vessel on an older build
  // still checks in normally; office simply has nothing to compare against.
  vesselName: Type.Optional(Type.String()),
  imoNumber: Type.Optional(Type.String()),
  // The vessel's own id for this sync cycle, so both sides file their half
  // of one run under the same reference.
  runId: Type.Optional(Type.String()),
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
  // Highest schema_versions.cursor this vessel already holds. Absent on a
  // vessel that has never pulled one, which starts it from zero.
  lastSchemaCursor: Type.Optional(Type.String()),
  // What the vessel reports it is actually validating against. The cursor
  // above says how far it has read; this says what it ended up with, which
  // is not the same thing when a published document failed to compile
  // aboard. Optional so an older build still checks in normally.
  appliedSchemas: Type.Optional(
    Type.Array(
      Type.Object({
        schemaName: Type.String(),
        version: Type.String(),
        publishedAt: Type.String(),
      }),
    ),
  ),
  // The config bundle the vessel actually holds, read back from its own
  // store. Office used to record what it *served* under this name and
  // then compare that against its own resolution, so the check could only
  // ever agree with itself — a vessel that received a bundle and then
  // refused it (an unreadable wire version, a failed write) still showed
  // as Synced. Only the ship can answer this. Null once reported means
  // "asked, and it has none", which is not the same as never having asked.
  appliedBundle: Type.Optional(
    Type.Union([
      Type.Object({ bundleId: Type.String(), versionNo: Type.Number() }),
      Type.Null(),
    ]),
  ),
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

const GetVesselSchema = Type.Object({
  id: UuidString(),
});
const GetVesselCompiler = TypeCompiler.Compile(GetVesselSchema);

const DeleteVesselSchema = Type.Object({
  id: Type.String(),
});
const DeleteVesselCompiler = TypeCompiler.Compile(DeleteVesselSchema);

const ResetVesselCredentialsSchema = Type.Object({
  id: UuidString(),
});
const ResetVesselCredentialsCompiler = TypeCompiler.Compile(ResetVesselCredentialsSchema);

const IssueEnrollmentSchema = Type.Object({
  vesselId: UuidString(),
});
const IssueEnrollmentCompiler = TypeCompiler.Compile(IssueEnrollmentSchema);

const RevokeEnrollmentSchema = Type.Object({
  vesselId: UuidString(),
});
const RevokeEnrollmentCompiler = TypeCompiler.Compile(RevokeEnrollmentSchema);

// The redemption request carries only the code. It is self-identifying:
// office resolves which vessel it belongs to by matching the code, which
// is precisely what removes IMO as an unauthenticated identity claim.
const RedeemEnrollmentSchema = Type.Object({
  code: Type.String(),
  // The vessel mints its own disaster-recovery keypair at redemption and
  // sends only the public half. Office can then encrypt a restore bundle
  // *to* that vessel while never being able to open one itself. Optional
  // so a node built before this exchange existed can still enrol — it
  // simply has no restore path until it re-redeems.
  drPublicKey: Type.Optional(Type.String()),
});
const RedeemEnrollmentCompiler = TypeCompiler.Compile(RedeemEnrollmentSchema);

const SchemaHistorySchema = Type.Object({ schemaName: Type.String() });
const SchemaHistoryCompiler = TypeCompiler.Compile(SchemaHistorySchema);

const SchemaVersionSchema = Type.Object({ schemaName: Type.String(), version: Type.String() });
const SchemaVersionCompiler = TypeCompiler.Compile(SchemaVersionSchema);

const QueryMissingChunksSchema = Type.Object({
  vesselId: UuidString(),
  attachment: Type.Object({
    reportId: Type.String(),
    versionNo: Type.Number(),
    fieldName: Type.String(),
    filename: Type.String(),
    contentType: Type.String(),
    contentHash: Type.String(),
    totalSize: Type.Number(),
    chunkSize: Type.Number(),
  }),
});
const QueryMissingChunksCompiler = TypeCompiler.Compile(QueryMissingChunksSchema);

const UploadChunkSchema = Type.Object({
  vesselId: UuidString(),
  contentHash: Type.String(),
  chunkIndex: Type.Number(),
  // base64 — the transport is JSON, so bytes cannot travel raw.
  data: Type.String(),
});
const UploadChunkCompiler = TypeCompiler.Compile(UploadChunkSchema);

const ListReportAttachmentsSchema = Type.Object({
  vesselId: UuidString(),
  reportId: Type.String(),
});
const ListReportAttachmentsCompiler = TypeCompiler.Compile(ListReportAttachmentsSchema);

const VesselIdSchema = Type.Object({ vesselId: UuidString() });
const VesselIdCompiler = TypeCompiler.Compile(VesselIdSchema);

const PushRestoreBundleSchema = Type.Object({
  vesselId: UuidString(),
  reason: Type.Optional(Type.String()),
});
const PushRestoreBundleCompiler = TypeCompiler.Compile(PushRestoreBundleSchema);

const FetchRestoreBundleSchema = Type.Object({
  vesselId: UuidString(),
  commandId: Type.String(),
});
const FetchRestoreBundleCompiler = TypeCompiler.Compile(FetchRestoreBundleSchema);

const AckRestoreBundleSchema = Type.Object({
  vesselId: UuidString(),
  commandId: Type.String(),
});
const AckRestoreBundleCompiler = TypeCompiler.Compile(AckRestoreBundleSchema);

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

// vesselId is optional: the port keys reports on reportId alone
// everywhere else, but the original scopes these by vessel, and a
// reportId is only guaranteed unique within a vessel. Accepting both
// lets the caller be precise where it can be.
const ReportHistorySchema = Type.Object({
  reportId: Type.String(),
  vesselId: Type.Optional(UuidString()),
});
const ReportHistoryCompiler = TypeCompiler.Compile(ReportHistorySchema);

const GetEnumSchema = Type.Object({
  enumRef: Type.String(),
});
const GetEnumCompiler = TypeCompiler.Compile(GetEnumSchema);

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

const BulkMarkReviewedSchema = Type.Object({
  reportIds: Type.Array(Type.String()),
});
const BulkMarkReviewedCompiler = TypeCompiler.Compile(BulkMarkReviewedSchema);

const CreateApiKeySchema = Type.Object({
  label: Type.String(),
  groupId: Type.Optional(Type.String()),
});
const CreateApiKeyCompiler = TypeCompiler.Compile(CreateApiKeySchema);

const RevokeApiKeySchema = Type.Object({
  id: UuidString(),
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

/**
 * Applied to every procedure: the services throw Nest exceptions and
 * tRPC would otherwise report all of them as 500s. See
 * rpc/http-error.middleware.ts.
 */
const mapDomainErrors = domainErrorMapper(t);
export const publicProcedure = t.procedure.use(mapDomainErrors);
export const router = t.router;

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

export const edgeProcedure = t.procedure.use(mapDomainErrors).use(isEdgeAuthed);

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

export const protectedProcedure = t.procedure.use(mapDomainErrors).use(isAuthed);

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
    private readonly restoreBundleService: RestoreBundleService,
    private readonly attachmentsService: AttachmentsService,
    private readonly supertokensService: SupertokensService,
    private readonly notificationsService: NotificationsService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * Confirms the bearer token isEdgeAuthed hashed actually belongs to a
   * live, unrevoked row in api_keys. isEdgeAuthed itself only checks the
   * header's *shape* (it runs before DI construction, with no `this.db`
   * to query) — every edgeProcedure handler must call this before doing
   * anything else, or it accepts any string shaped like
   * "Bearer ovl_prod_...", real key or not.
   */
  private async verifyEdgeApiKey(ctx: { tokenLookupHash: string; tokenHash: string }): Promise<void> {
    const keys = await this.db.select().from(schema.apiKeys)
      .where(eq(schema.apiKeys.tokenLookupHash, ctx.tokenLookupHash));

    if (keys.length === 0 || keys[0].tokenHash !== ctx.tokenHash || keys[0].revokedAt) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid or revoked API key' });
    }
    await this.touchApiKey(keys[0]);
  }

  /**
   * Records that a key was just used.
   *
   * api_keys.last_used_at has always been on the schema and shown on the
   * API Access screen, but nothing ever wrote it — "Last used" was
   * permanently blank, which reads as "never used" for a key a vessel
   * has been syncing with every thirty seconds.
   *
   * Deliberately a column update rather than an api_key_events row.
   * Vessels check in on a 30-second cycle, so a row per request would add
   * roughly three thousand rows per vessel per day to a table meant to
   * hold a handful of administrative milestones. Throttled on top of
   * that, because the answer only needs to be good to the minute and
   * writing on every request would put a write in front of every sync.
   */
  private async touchApiKey(key: { id: string; lastUsedAt: string | null }): Promise<void> {
    const now = Date.now();
    if (key.lastUsedAt && now - new Date(key.lastUsedAt).getTime() < API_KEY_TOUCH_INTERVAL_MS) return;
    try {
      await this.db
        .update(schema.apiKeys)
        .set({ lastUsedAt: new Date(now).toISOString() })
        .where(eq(schema.apiKeys.id, key.id));
    } catch (err: any) {
      // Never fail a sync over bookkeeping. The vessel's report matters
      // more than knowing precisely when its key was last seen.
      console.warn(`Could not stamp last-used on api key ${key.id}: ${err.message}`);
    }
  }

  /**
   * Appends one milestone to a key's activity log — ports
   * store.RecordAPIKeyEvent. Only rare, administrative moments land here
   * (see touchApiKey for why usage does not).
   */
  private async recordApiKeyEvent(apiKeyId: string, kind: string): Promise<void> {
    try {
      await this.db.insert(schema.apiKeyEvents).values({ apiKeyId, kind, at: new Date().toISOString() });
    } catch (err: any) {
      console.warn(`Could not record ${kind} event for api key ${apiKeyId}: ${err.message}`);
    }
  }

  /**
   * Confirms the bearer token belongs specifically to this vesselId, not
   * merely to some valid provisioning key — provisioning keys (checked by
   * verifyEdgeApiKey) are deliberately shared across a whole fleet and
   * only ever prove "allowed to enroll", so they can't be the credential
   * that separates one vessel's sync traffic from another's. edge.enroll
   * mints this secret per vessel; every sync.pushEvents/pullConfig call
   * must present that same vessel's own secret, not any other vessel's or
   * the original provisioning key.
   */
  private async verifyVesselCredential(vesselId: string, ctx: { tokenHash: string }): Promise<void> {
    const rows = await this.db.select().from(schema.vesselCredentials)
      .where(eq(schema.vesselCredentials.vesselId, vesselId));

    if (rows.length === 0 || rows[0].tokenHash !== ctx.tokenHash || rows[0].revokedAt) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Invalid vessel credential. Re-enroll this vessel from its setup screen.',
      });
    }
  }

  /**
   * Loads the office user behind a session and asserts a role.
   *
   * This is a method rather than a tRPC middleware because the role
   * check needs SupertokensService, and middleware is defined at module
   * scope before DI has constructed anything (see isAuthed's own
   * comment). protectedProcedure therefore proves only that *a session
   * exists* — it says nothing about what that account may do, so every
   * privileged procedure has to assert its role explicitly, the same way
   * the REST UsersController already does with requireAdmin.
   */
  private async assertRole(ctx: { session: { getUserId(): string } }, role: string, action: string): Promise<void> {
    const localUser = await this.supertokensService.getLocalUser(ctx.session.getUserId());
    const roles = Array.isArray(localUser?.roles) ? (localUser!.roles as string[]) : [];
    if (!roles.includes(role)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: action });
    }
  }

  /**
   * Guards the destructive and credential-bearing procedures — the same
   * set ovl/office/httpapi gates behind requireAdmin (apikeys.go:44,
   * users.go:17, vesselgroups.go:35, vessels.go:260/397/454/531,
   * vesselusers.go:110). Without it any authenticated account, including
   * a viewer, could mint an enrollment code and take over a vessel.
   */
  private assertAdmin(ctx: { session: { getUserId(): string } }): Promise<void> {
    return this.assertRole(ctx, 'admin', 'Admin role required.');
  }

  /**
   * Guards schema/field-policy/compliance authoring — ports
   * requireConfigManager (schemaversions.go:20).
   */
  private assertConfigManager(ctx: { session: { getUserId(): string } }): Promise<void> {
    return this.assertRole(ctx, 'configManager', 'Only a Config Manager may author configuration.');
  }

  /**
   * Pairs each schema office has published with the version this vessel
   * reports holding — design handoff B2's Config tab needs both halves to
   * say anything useful, and "latest published" alone would silently read
   * as "what the ship has".
   *
   * A vessel that has never checked in since this reporting existed sends
   * nothing, which is reported as unknown rather than as out of date:
   * those are different problems with different fixes.
   */
  private async vesselAppliedSchemas(applied: unknown) {
    const reported = new Map<string, { version: string; publishedAt: string }>();
    if (Array.isArray(applied)) {
      for (const row of applied as { schemaName: string; version: string; publishedAt: string }[]) {
        if (row?.schemaName) reported.set(row.schemaName, { version: row.version, publishedAt: row.publishedAt });
      }
    }

    const publishedRows = await this.db
      .select({
        schemaName: schema.schemaVersions.schemaName,
        version: schema.schemaVersions.version,
        publishedAt: schema.schemaVersions.publishedAt,
      })
      .from(schema.schemaVersions)
      .orderBy(desc(schema.schemaVersions.publishedAt));

    const latestPublished = new Map<string, { version: string; publishedAt: string }>();
    for (const row of publishedRows) {
      if (!latestPublished.has(row.schemaName)) {
        latestPublished.set(row.schemaName, { version: row.version, publishedAt: row.publishedAt });
      }
    }

    const names = new Set([...latestPublished.keys(), ...reported.keys()]);
    return Array.from(names)
      .sort()
      .map((schemaName) => {
        const published = latestPublished.get(schemaName) ?? null;
        const onVessel = reported.get(schemaName) ?? null;
        return {
          schemaName,
          publishedVersion: published?.version ?? null,
          publishedAt: published?.publishedAt ?? null,
          vesselVersion: onVessel?.version ?? null,
          // Three states, not two: never-reported is not the same as
          // behind, and telling an operator a ship is out of date when it
          // simply has not called in yet sends them after the wrong thing.
          status: !reported.size
            ? ('unknown' as const)
            : !onVessel
              ? ('missing' as const)
              : published && onVessel.version === published.version
                ? ('current' as const)
                : ('behind' as const),
        };
      });
  }

  /**
   * Issues (or reissues) this vessel's long-lived sync credential and
   * returns the plaintext exactly once — only the hash is stored, so it
   * is unrecoverable afterwards.
   *
   * Upserting on the vesselId primary key means reissuing replaces the
   * previous secret in place and clears any revocation: that is how a
   * vessel recovers after losing its local database, and how an operator
   * undoes a Reset Credentials. The old secret stops working the moment
   * this returns.
   */
  private async mintVesselCredential(vesselId: string): Promise<string> {
    const rawSecret = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawSecret).digest('hex');
    const tokenLookupHash = crypto.createHash('sha256').update(rawSecret.substring(0, 8)).digest('hex');
    const now = new Date().toISOString();

    await this.db.insert(schema.vesselCredentials)
      .values({ vesselId, tokenHash, tokenLookupHash, issuedAt: now })
      .onConflictDoUpdate({
        target: schema.vesselCredentials.vesselId,
        set: { tokenHash, tokenLookupHash, issuedAt: now, revokedAt: null },
      });

    return `ovl_prod_${rawSecret}`;
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

  /**
   * Shore's half of one sync run. Never allowed to break a check-in: history
   * is diagnostic, and a vessel must still sync if recording it fails.
   * `tenantId` is left at its column default for now — the column exists so
   * that per-tenant history does not require back-filling an append-only
   * table later.
   */
  private async recordSyncRun(run: {
    runId: string | null;
    vesselId: string;
    outcome: 'served' | 'noBundle' | 'unknownVessel';
    resolvedBundleId?: string | null;
    resolvedBundleVersion?: number | null;
    reportedName: string | null;
    reportedImo: string | null;
    note?: string | null;
  }) {
    try {
      await this.db.insert(schema.syncRuns).values({
        runId: run.runId,
        vesselId: run.vesselId,
        receivedAt: new Date().toISOString(),
        outcome: run.outcome,
        resolvedBundleId: run.resolvedBundleId ?? null,
        resolvedBundleVersion: run.resolvedBundleVersion ?? null,
        reportedName: run.reportedName,
        reportedImo: run.reportedImo,
        note: run.note ?? null,
      });
    } catch (err: any) {
      console.error(`Could not record sync run for vessel ${run.vesselId}:`, err?.message ?? err);
    }
  }

  appRouter = router({
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
          await this.verifyEdgeApiKey(ctx);

          // Validated before the lookup, not just on the implicit-create
          // path: a malformed IMO can't identify a real hull either way,
          // and rejecting it here means a typo is reported as a typo
          // rather than silently registering a second vessel.
          const enrollImo = input.imoNumber.trim();
          const enrollImoError = validateImo(enrollImo);
          if (enrollImoError) throw new TRPCError({ code: 'BAD_REQUEST', message: enrollImoError });

          // 2. Lookup Vessel by IMO
          const existing = await this.db.select().from(schema.vessels).where(eq(schema.vessels.imo, enrollImo));
          
          let vesselId;
          if (existing.length > 0) {
            vesselId = existing[0].id;
          } else {
            // Create implicitly (IMO already validated above)
            const newVessel = await this.db.insert(schema.vessels).values({
              name: input.vesselName,
              imo: enrollImo,
              type: 'Cargo', // Default
              groups: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }).returning();
            vesselId = newVessel[0].id;
          }

          // 3. Mint this vessel's own sync credential — distinct from the
          // provisioning key just verified above, and never shared with
          // any other vessel.
          const vesselSecret = await this.mintVesselCredential(vesselId);

          return { vesselId, vesselSecret };
        }),

      /**
       * Exchanges a one-time enrollment code for this vessel's identity
       * and sync credential — ports enrollment.Redeem.
       *
       * publicProcedure, not edgeProcedure: the code *is* the credential
       * here, so requiring a fleet-wide provisioning key as well would
       * reintroduce the shared secret this flow exists to remove. A
       * vessel being set up has nothing else to present.
       *
       * The vessel sends no id, name or IMO. Office matches the code
       * against every issued enrollment and the winner determines which
       * vessel this is, so identity can no longer be asserted by typing
       * someone else's IMO.
       */
      redeem: publicProcedure
        .input((val: unknown) => {
          if (!RedeemEnrollmentCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof RedeemEnrollmentSchema>;
        })
        .mutation(async ({ input }) => {
          const code = canonicalizeCode(input.code);
          if (!code) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Enrollment code is required.' });

          // Linear argon2 scan over issued enrollments. Deliberate, and
          // the same call the Go original makes: the code is
          // self-identifying, so there is no id to look up by — only the
          // code itself. Redemption is a one-time human-driven bootstrap
          // bounded by fleet size, not a per-request hot path (contrast
          // vessel_credentials, which carries a lookup hash precisely
          // because that check runs on every sync RPC).
          const candidates = await this.db
            .select()
            .from(schema.enrollments)
            .where(eq(schema.enrollments.state, 'issued'));

          let matched: (typeof candidates)[number] | undefined;
          for (const candidate of candidates) {
            if (!isRedeemable(candidate.state as EnrollmentState, candidate.codeHash)) continue;
            if (await argon2.verify(candidate.codeHash, code).catch(() => false)) {
              matched = candidate;
              break;
            }
          }

          if (!matched) {
            throw new TRPCError({
              code: 'UNAUTHORIZED',
              message: 'Enrollment code is not recognised, or has already been used.',
            });
          }

          const vessel = (
            await this.db.select().from(schema.vessels).where(eq(schema.vessels.id, matched.vesselId)).limit(1)
          )[0];
          if (!vessel) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'The vessel this code was issued for no longer exists.' });
          }

          // Single use: the hash is cleared, not merely the state flag,
          // so the same code can never verify again even if a later code
          // path forgets to check state first.
          const now = new Date().toISOString();
          await this.db
            .update(schema.enrollments)
            .set({
              state: 'enrolled',
              codeHash: '',
              updatedAt: now,
              // Replaced on every redemption, never merged: a vessel that
              // re-redeems has minted a fresh keypair and the old public
              // key can no longer be opened by anyone. Keeping the
              // previous one would leave office able to produce bundles
              // the vessel has lost the private half of.
              ...(input.drPublicKey ? { drPublicKey: input.drPublicKey } : { drPublicKey: null }),
            })
            .where(eq(schema.enrollments.vesselId, matched.vesselId));

          const vesselSecret = await this.mintVesselCredential(vessel.id);

          // Identity travels back with the credential, so the vessel can
          // display who it is without anyone having typed it in.
          return {
            vesselId: vessel.id,
            vesselSecret,
            vesselName: vessel.name,
            imoNumber: vessel.imo,
          };
        }),
    }),

    sync: router({
      pushEvents: edgeProcedure
        .input((val: unknown) => {
          if (!PushEventsCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof PushEventsSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          await this.verifyVesselCredential(input.vesselId, ctx);

          console.log(`Office received ${input.events.length} events from vessel ${input.vesselId}`);

          await this.db.insert(schema.vesselSyncStatus)
            .values({ vesselId: input.vesselId, lastSeenAt: new Date().toISOString() })
            .onConflictDoUpdate({
              target: schema.vesselSyncStatus.vesselId,
              set: { lastSeenAt: new Date().toISOString() },
            });

          const failedIds: string[] = [];

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
                failedIds.push(event.id);
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
                failedIds.push(event.id);
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
                failedIds.push(event.id);
              }
            } else {
              console.warn(`Unrecognized outbox eventType "${event.eventType}" from vessel ${input.vesselId} — dropped.`);
            }
          }

          return {
            success: true,
            processedCount: input.events.length - failedIds.length,
            failedIds,
          };
        }),

      pullConfig: edgeProcedure
        .input((val: unknown) => {
          if (!PullConfigInputCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof PullConfigInputSchema>;
        })
        .query(async ({ input, ctx }) => {
          await this.verifyVesselCredential(input.vesselId, ctx);

          // Check the vessel is actually registered before touching
          // vessel_sync_status. That table has an FK onto vessels, so an
          // unknown id used to surface as a raw Postgres foreign-key
          // violation from deep inside the insert — which the vessel then
          // swallowed, leaving "sync complete" and no bundle. A vessel
          // holding an id that shore has never heard of (office database
          // rebuilt after enrolment, vessel restored from a backup) needs
          // to be told to re-enrol, not handed a constraint error.
          const knownVessel = (
            await this.db
              .select()
              .from(schema.vessels)
              .where(eq(schema.vessels.id, input.vesselId))
              .limit(1)
          )[0];
          if (!knownVessel) {
            // Recorded before throwing. A vessel office cannot identify is
            // exactly the case that previously vanished without trace, so
            // the attempt itself is the thing worth keeping — sync_runs has
            // no FK onto vessels precisely so this insert can succeed.
            await this.recordSyncRun({
              runId: input.runId ?? null,
              vesselId: input.vesselId,
              outcome: 'unknownVessel',
              reportedName: input.vesselName ?? null,
              reportedImo: input.imoNumber ?? null,
              note: 'Vessel id is not registered with this office.',
            });
            throw new TRPCError({
              code: 'NOT_FOUND',
              message:
                `Vessel ${input.vesselId} is not registered with this office. ` +
                `Re-enrol the vessel from its setup screen.`,
            });
          }

          const bundle = await this.configBundleService.resolveForVessel(input.vesselId);
          const syncedAt = new Date().toISOString();

          await this.db.insert(schema.vesselSyncStatus)
            .values({
              vesselId: input.vesselId,
              lastSeenAt: syncedAt,
              // What the vessel reports holding, not what office resolved
              // for it. `undefined` is an older build that cannot answer,
              // and is recorded as nothing rather than as agreement.
              appliedBundleId: input.appliedBundle?.bundleId ?? '',
              appliedBundleVersion: input.appliedBundle?.versionNo ?? 0,
              reportedName: input.vesselName ?? null,
              reportedImo: input.imoNumber ?? null,
              appliedSchemas: input.appliedSchemas ?? [],
            })
            .onConflictDoUpdate({
              target: schema.vesselSyncStatus.vesselId,
              set: {
                lastSeenAt: syncedAt,
                // Only overwritten by a vessel that actually reported, so
                // an older build checking in cannot blank out what a newer
                // one already told us.
                ...(input.appliedBundle !== undefined
                  ? {
                      appliedBundleId: input.appliedBundle?.bundleId ?? '',
                      appliedBundleVersion: input.appliedBundle?.versionNo ?? 0,
                    }
                  : {}),
                reportedName: input.vesselName ?? null,
                reportedImo: input.imoNumber ?? null,
                // Left untouched by a vessel that does not report them, so
                // an older build checking in cannot blank out what a newer
                // one already told us.
                ...(input.appliedSchemas ? { appliedSchemas: input.appliedSchemas } : {}),
              },
            });

          await this.recordSyncRun({
            runId: input.runId ?? null,
            vesselId: input.vesselId,
            outcome: bundle ? 'served' : 'noBundle',
            resolvedBundleId: bundle?.bundleId ?? null,
            resolvedBundleVersion: bundle?.versionNo ?? null,
            reportedName: input.vesselName ?? null,
            reportedImo: input.imoNumber ?? null,
            note: bundle ? null : 'No bundle assignment covers this vessel.',
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

          // Anything an admin has pushed that this vessel has not yet
          // confirmed applying. Cheap enough to read every cycle — it is
          // an indexed lookup returning nothing at all in the normal
          // case, since restore commands are a rare recovery action.
          const restoreCommands = await this.restoreBundleService.pendingCommands(input.vesselId);

          // The schema documents themselves, not just the field policies
          // the config bundle already carries. Without this the vessel can
          // only ever validate against the OVD schemas baked into its own
          // build, so publishing a new version ashore reached no ship —
          // the office's whole schema-publishing feature had no effect on
          // the fleet. Cursor-based, so a vessel already up to date
          // transfers nothing.
          const schemaVersions = await this.schemaVersionsService.listSince(
            input.lastSchemaCursor ? Number(input.lastSchemaCursor) : 0,
          );

          return {
            bundle,
            syncedAt,
            // Shore's own record of this vessel, echoed back so the ship can
            // display both names and flag a divergence locally.
            vessel: { id: knownVessel.id, name: knownVessel.name, imo: knownVessel.imo },
            userCommands,
            chatMessages,
            remarks,
            invalidationNotices,
            // Piggybacked on the same check-in as user commands, for the
            // same reason: a vessel that has lost its data should not
            // need a second round trip to discover shore is trying to
            // rebuild it. Only the notification travels here — the
            // bundle itself is far too large to attach to every poll, so
            // the vessel calls fetchRestoreBundle for the bytes.
            restoreCommands,
            schemaVersions,
          };
        }),

      /**
       * Hands the calling vessel its own encrypted restore bundle —
       * ports ovl/office/syncservice.FetchRestoreBundle.
       *
       * Authenticated with the vessel's own sync credential, exactly
       * like every other sync RPC: no auth carve-out is needed here, and
       * verifyVesselCredential is what stops one vessel asking for
       * another's history.
       *
       * Built and encrypted fresh on every call rather than cached when
       * the command was queued — see RestoreBundleService's own note.
       */
      fetchRestoreBundle: edgeProcedure
        .input((val: unknown) => {
          if (!FetchRestoreBundleCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof FetchRestoreBundleSchema>;
        })
        .query(async ({ input, ctx }) => {
          await this.verifyVesselCredential(input.vesselId, ctx);

          const command = (
            await this.db
              .select()
              .from(schema.restoreCommands)
              .where(
                and(
                  eq(schema.restoreCommands.id, input.commandId),
                  eq(schema.restoreCommands.vesselId, input.vesselId),
                ),
              )
              .limit(1)
          )[0];
          if (!command) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'No such restore command for this vessel.' });
          }

          let built: Awaited<ReturnType<RestoreBundleService['buildEncrypted']>>;
          try {
            built = await this.restoreBundleService.buildEncrypted(input.vesselId);
          } catch (err: any) {
            throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message });
          }

          // Fetched, not applied. Only the vessel knows whether the
          // bundle actually landed, and it says so via ackRestoreBundle
          // — so a fetch that decrypts or applies badly is retried on
          // the next cycle instead of being marked done here.
          await this.db
            .update(schema.restoreCommands)
            .set({ fetchedAt: new Date().toISOString() })
            .where(eq(schema.restoreCommands.id, command.id));

          return {
            commandId: command.id,
            reason: command.reason,
            ciphertextBase64: built.ciphertextBase64,
            reportCount: built.reportCount,
            versionCount: built.versionCount,
            generatedAt: built.bundle.generatedAt,
          };
        }),

      /**
       * Attachment ingest, first half — ports
       * ovl/office/syncservice.QueryMissingAttachmentChunks.
       *
       * The vessel declares an attachment and office answers which chunks
       * it still needs. Authenticated with the vessel's own credential,
       * like every other sync call, so one ship cannot file attachments
       * against another's reports.
       */
      queryMissingAttachmentChunks: edgeProcedure
        .input((val: unknown) => {
          if (!QueryMissingChunksCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof QueryMissingChunksSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          await this.verifyVesselCredential(input.vesselId, ctx);
          try {
            return await this.attachmentsService.queryMissingChunks(
              input.vesselId,
              input.attachment as AttachmentMeta,
            );
          } catch (err: any) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
          }
        }),

      /**
       * Attachment ingest, second half — ports UploadAttachmentChunk.
       * Office assembles, verifies the declared sha256 and promotes the
       * result once the last chunk lands.
       */
      uploadAttachmentChunk: edgeProcedure
        .input((val: unknown) => {
          if (!UploadChunkCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof UploadChunkSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          await this.verifyVesselCredential(input.vesselId, ctx);
          try {
            return await this.attachmentsService.uploadChunk(
              input.contentHash,
              input.chunkIndex,
              Buffer.from(input.data, 'base64'),
            );
          } catch (err: any) {
            // A hash mismatch is data loss, not a bad request: the
            // vessel's chunks were accepted individually and only the
            // assembled whole failed, so the distinction tells it to
            // restart the transfer rather than fix its call.
            const code = /hash mismatch/.test(err.message) ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST';
            throw new TRPCError({ code, message: err.message });
          }
        }),

      /**
       * The vessel's confirmation that a restore bundle was decrypted
       * and applied. This is what closes a restore command out; until it
       * arrives the command keeps reappearing in pullConfig, which is
       * the behaviour a half-completed restore needs.
       */
      ackRestoreBundle: edgeProcedure
        .input((val: unknown) => {
          if (!AckRestoreBundleCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof AckRestoreBundleSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          await this.verifyVesselCredential(input.vesselId, ctx);
          const now = new Date().toISOString();
          const updated = await this.db
            .update(schema.restoreCommands)
            .set({ appliedAt: now })
            .where(
              and(
                eq(schema.restoreCommands.id, input.commandId),
                eq(schema.restoreCommands.vesselId, input.vesselId),
              ),
            )
            .returning({ id: schema.restoreCommands.id });
          if (updated.length === 0) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'No such restore command for this vessel.' });
          }
          return { appliedAt: now };
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
      /**
       * One vessel's composed detail view — ports handleGetVessel's
       * vesselDetailView (vessels.go:289), which the port had no
       * equivalent of at all, so the vessel detail screen could not be
       * assembled from anything.
       *
       * Composed server-side rather than left to the client to fan out:
       * the screen needs the profile, enrollment state, resolved bundle
       * and sync status together, and four round trips to paint one page
       * is the pattern this codebase already went out of its way to
       * remove elsewhere (see reports' own "one round trip" commit).
       *
       * restoreCommands is deliberately absent from this port: the DR
       * chain (backupcrypto/restorebundle) has no implementation here
       * yet, so returning an empty array would imply a working feature.
       */
      get: protectedProcedure
        .input((val: unknown) => {
          if (!GetVesselCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof GetVesselSchema>;
        })
        .query(async ({ input }) => {
          const vessel = (
            await this.db.select().from(schema.vessels).where(eq(schema.vessels.id, input.id)).limit(1)
          )[0];
          if (!vessel) throw new TRPCError({ code: 'NOT_FOUND', message: 'Vessel not found.' });

          const [syncStatus] = await this.db
            .select()
            .from(schema.vesselSyncStatus)
            .where(eq(schema.vesselSyncStatus.vesselId, input.id))
            .limit(1);

          const [enrollmentRow] = await this.db
            .select()
            .from(schema.enrollments)
            .where(eq(schema.enrollments.vesselId, input.id))
            .limit(1);

          const [credential] = await this.db
            .select()
            .from(schema.vesselCredentials)
            .where(eq(schema.vesselCredentials.vesselId, input.id))
            .limit(1);

          const bundle = await this.configBundleService.resolveForVessel(input.id);
          const [roster, commands] = await Promise.all([
            this.vesselUsersService.listRoster(input.id),
            this.vesselUsersService.listCommands(input.id),
          ]);

          const lastSeenMs = syncStatus?.lastSeenAt ? new Date(syncStatus.lastSeenAt).getTime() : null;

          return {
            vessel: {
              id: vessel.id,
              name: vessel.name,
              imo: vessel.imo,
              type: vessel.type,
              groups: (vessel.groups as string[]) ?? [],
              createdAt: vessel.createdAt,
              updatedAt: vessel.updatedAt,
            },
            sync: {
              lastSeenAt: syncStatus?.lastSeenAt ?? null,
              edgeStatus:
                lastSeenMs === null ? 'Offline' : Date.now() - lastSeenMs <= ONLINE_THRESHOLD_MS ? 'Online' : 'Offline',
              appVersion: syncStatus?.appVersion || null,
              // What the vessel calls itself, as distinct from the
              // shore-authored name above.
              reportedName: syncStatus?.reportedName ?? null,
              reportedImo: syncStatus?.reportedImo ?? null,
            },
            // The code hash is never exposed — only whether one is
            // outstanding, which is all the screen needs to decide
            // between "issue" and "reissue".
            enrollment: enrollmentRow
              ? {
                  state: enrollmentRow.state,
                  issuedAt: enrollmentRow.issuedAt,
                  revokedAt: enrollmentRow.revokedAt,
                  codeOutstanding: enrollmentRow.state === 'issued' && !!enrollmentRow.codeHash,
                }
              : null,
            // Whether this vessel can currently sync, and since when.
            // Never the hash — only the fact, which is what makes a
            // Reset Credentials visible instead of silent.
            credential: credential
              ? { issuedAt: credential.issuedAt, revokedAt: credential.revokedAt, active: !credential.revokedAt }
              : null,
            bundle: bundle
              ? { bundleId: bundle.bundleId, versionNo: bundle.versionNo, publishedAt: bundle.publishedAt }
              : null,
            // What the ship reports actually holding, as distinct from the
            // assignment above. `reported: false` means it has never told
            // us — which is not the same as holding nothing, and must not
            // be rendered as though the two agree.
            appliedBundle: {
              reported: !!syncStatus,
              bundleId: syncStatus?.appliedBundleId || null,
              versionNo: syncStatus?.appliedBundleVersion ?? null,
              matchesAssigned: !!bundle && syncStatus?.appliedBundleId === bundle.bundleId,
            },
            // What the vessel says it is actually validating against,
            // paired with what office has published, so the two can be
            // compared rather than assumed equal. A ship that is behind —
            // or stuck because a document would not compile aboard — is
            // only visible by putting these side by side.
            schemas: await this.vesselAppliedSchemas(syncStatus?.appliedSchemas),
            users: roster,
            userCommands: commands,
          };
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
        .mutation(async ({ input, ctx }) => {
          await this.assertAdmin(ctx);
          // Ported from ovl/office/vessels/vessel.go's NewVessel, which
          // validates the IMO before a vessel can exist at all.
          const imo = input.imo.trim();
          const imoError = validateImo(imo);
          if (imoError) throw new TRPCError({ code: 'BAD_REQUEST', message: imoError });

          const newVessel = await this.db.insert(schema.vessels).values({
            name: input.name,
            imo,
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
        .mutation(async ({ input, ctx }) => {
          await this.assertAdmin(ctx);
          const { id, ...updates } = input;

          // Every IMO that passes through here must be well-formed, with
          // no exemption for values already in the table: the existing
          // rows were backfilled to valid numbers when this rule landed,
          // so there is no legacy tier left to grandfather.
          if (updates.imo !== undefined) {
            const imo = updates.imo.trim();
            const imoError = validateImo(imo);
            if (imoError) throw new TRPCError({ code: 'BAD_REQUEST', message: imoError });
            updates.imo = imo;
          }

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
        .mutation(async ({ input, ctx }) => {
          await this.assertAdmin(ctx);
          await this.db.delete(schema.vessels).where(eq(schema.vessels.id, input.id));
          return { success: true };
        }),
      // Revokes this vessel's own sync credential without touching the
      // fleet-wide provisioning keys under Global Settings — for a single
      // compromised or decommissioned vessel, that's the blast radius that
      // should be cut off, not every other vessel's ability to sync. Soft
      // revoke (matches apiKeys.revoke's own pattern) rather than delete,
      // so issuedAt/history survives — every subsequent pushEvents/
      // pullConfig from it fails closed (verifyVesselCredential sees
      // revokedAt set) until someone re-runs its setup wizard with a valid
      // provisioning key, which reissues a live one.
      resetCredentials: protectedProcedure
        .input((val: unknown) => {
          if (!ResetVesselCredentialsCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof ResetVesselCredentialsSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          await this.assertAdmin(ctx);
          await this.db
            .update(schema.vesselCredentials)
            .set({ revokedAt: new Date().toISOString() })
            .where(eq(schema.vesselCredentials.vesselId, input.id));
          return { success: true };
        }),

      /**
       * Issues a one-time enrollment code for one vessel — ports
       * enrollment.Issue/Reissue. The plaintext is returned exactly once
       * and only its argon2id hash is stored, so it cannot be recovered
       * later; reissuing replaces the previous code in place rather than
       * accumulating history (there is at most one enrollment per
       * vessel, keyed on vesselId).
       *
       * argon2id rather than a fast hash: issuing is a rare,
       * human-driven admin action, and one hashing primitive for every
       * secret this project stores is simpler than two.
       */
      issueEnrollment: protectedProcedure
        .input((val: unknown) => {
          if (!IssueEnrollmentCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof IssueEnrollmentSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          await this.assertAdmin(ctx);
          const vessel = (
            await this.db.select().from(schema.vessels).where(eq(schema.vessels.id, input.vesselId)).limit(1)
          )[0];
          if (!vessel) throw new TRPCError({ code: 'NOT_FOUND', message: 'Vessel not found.' });

          const code = generateEnrollmentCode();
          const codeHash = await argon2.hash(canonicalizeCode(code), { type: argon2.argon2id });
          const now = new Date().toISOString();

          await this.db
            .insert(schema.enrollments)
            .values({
              vesselId: vessel.id,
              state: 'issued',
              codeHash,
              // The vessel's crew choose their own Master password during
              // setup, so office does not pre-generate one. These columns
              // exist for the original's printable-sheet flow and are left
              // empty rather than filled with a credential nobody uses.
              initialMasterUsername: '',
              initialMasterPasswordHash: '',
              issuedAt: now,
              revokedAt: null,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: schema.enrollments.vesselId,
              set: { state: 'issued', codeHash, issuedAt: now, revokedAt: null, updatedAt: now },
            });

          return { code, vesselName: vessel.name, imo: vessel.imo };
        }),

      /**
       * Disaster recovery — ports ovl/office/httpapi's DR tab handlers.
       *
       * Two ways the same bundle reaches a vessel that has lost its data:
       * generateRestoreBundle hands an admin the encrypted file to carry
       * aboard by hand, and pushRestoreBundle queues a command the vessel
       * collects itself on its next sync. Both produce identical bytes;
       * which one to use is a question of whether the ship is reachable.
       *
       * Admin-gated, not merely authenticated: a restore bundle is one
       * vessel's entire reporting history in a single file.
       */
      generateRestoreBundle: protectedProcedure
        .input((val: unknown) => {
          if (!VesselIdCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof VesselIdSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          await this.assertAdmin(ctx);
          const vessel = (
            await this.db.select().from(schema.vessels).where(eq(schema.vessels.id, input.vesselId)).limit(1)
          )[0];
          if (!vessel) throw new TRPCError({ code: 'NOT_FOUND', message: 'Vessel not found.' });

          try {
            const built = await this.restoreBundleService.buildEncrypted(input.vesselId);
            return {
              // Named after the IMO rather than the internal id so the
              // file is identifiable to whoever carries it aboard.
              filename: `${vessel.imo || vessel.id}-restore-bundle.age`,
              ciphertextBase64: built.ciphertextBase64,
              reportCount: built.reportCount,
              versionCount: built.versionCount,
              generatedAt: built.bundle.generatedAt,
              configBundleIncluded: built.bundle.configBundle !== null,
            };
          } catch (err: any) {
            // The only expected failure is a vessel with no DR key, and
            // that is a precondition an operator can act on ("re-issue
            // its enrollment code"), not a server fault.
            throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message });
          }
        }),

      /**
       * Queues a restore for the vessel to collect on its next sync.
       *
       * The DR key is checked here, at push time, rather than only when
       * the vessel calls in: an admin who pushes to a vessel that cannot
       * receive should be told now, not have the command sit unfetched
       * with no explanation.
       */
      pushRestoreBundle: protectedProcedure
        .input((val: unknown) => {
          if (!PushRestoreBundleCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof PushRestoreBundleSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          await this.assertAdmin(ctx);
          const localUser = await this.supertokensService.getLocalUser(ctx.session.getUserId());
          const actor = localUser?.username || 'unknown';
          const vessel = (
            await this.db.select().from(schema.vessels).where(eq(schema.vessels.id, input.vesselId)).limit(1)
          )[0];
          if (!vessel) throw new TRPCError({ code: 'NOT_FOUND', message: 'Vessel not found.' });

          if (!(await this.restoreBundleService.drPublicKey(input.vesselId))) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message:
                'This vessel has no restore key on file yet — issue it a new enrollment code and redeem it aboard before pushing a restore.',
            });
          }

          const reason = (input.reason ?? '').trim() || 'Restore bundle pushed from office';
          const now = new Date().toISOString();
          const [row] = await this.db
            .insert(schema.restoreCommands)
            .values({
              id: crypto.randomUUID(),
              vesselId: input.vesselId,
              reason,
              issuedBy: actor,
              issuedAt: now,
            })
            .returning({ id: schema.restoreCommands.id });

          return { id: row.id, reason, issuedBy: actor, issuedAt: now };
        }),

      /**
       * Every restore ever pushed to this vessel, with the fetched and
       * applied timestamps that answer "has it landed" — the DR tab
       * polls this rather than assuming a queued push succeeded.
       */
      restoreCommands: protectedProcedure
        .input((val: unknown) => {
          if (!VesselIdCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof VesselIdSchema>;
        })
        .query(async ({ input, ctx }) => {
          await this.assertAdmin(ctx);
          const commands = await this.restoreBundleService.listCommands(input.vesselId);
          return {
            commands,
            // The DR tab needs this to explain *why* the actions are
            // disabled, rather than just greying them out.
            hasRestoreKey: (await this.restoreBundleService.drPublicKey(input.vesselId)) !== null,
          };
        }),

      /**
       * Invalidates an outstanding code. Clears the hash as well as the
       * state so it can never verify again, matching Revoke's own rule in
       * the original.
       */
      revokeEnrollment: protectedProcedure
        .input((val: unknown) => {
          if (!RevokeEnrollmentCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof RevokeEnrollmentSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          await this.assertAdmin(ctx);
          const now = new Date().toISOString();
          await this.db
            .update(schema.enrollments)
            .set({ state: 'revoked', codeHash: '', revokedAt: now, updatedAt: now })
            .where(eq(schema.enrollments.vesselId, input.vesselId));
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
        .mutation(async ({ input, ctx }) => {
          await this.assertAdmin(ctx);
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
        .mutation(async ({ input, ctx }) => {
          await this.assertAdmin(ctx);
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
            await this.assertAdmin(ctx);
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
            await this.assertAdmin(ctx);
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
            await this.assertAdmin(ctx);
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
            await this.assertAdmin(ctx);
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
            await this.assertAdmin(ctx);
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
        .mutation(async ({ input, ctx }) => {
          await this.assertAdmin(ctx);
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
        .mutation(async ({ input, ctx }) => {
          await this.assertAdmin(ctx);
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
        .mutation(async ({ input, ctx }) => {
          await this.assertConfigManager(ctx);
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
      /**
       * The fleet report ledger, newest first, one row per report.
       *
       * All of this used to happen in Node: every report_versions row was
       * selected with no limit, deduplicated to the latest version per
       * reportId with a Map, sorted, and then `.slice(0, 100)`. So the
       * process read the entire report history into memory on every page
       * load and discarded all but the first hundred — and the hundredth
       * row was a silent floor with nothing in the UI to say more existed.
       *
       * DISTINCT ON does the deduplication in the database, and the page
       * is a keyset seek on (received_at, report_id) rather than an
       * offset: reports land continuously, so an offset shifts under the
       * reader and duplicates or skips rows between pages.
       */
      list: protectedProcedure
        .input((val: unknown) => {
          const v = (val ?? {}) as {
            limit?: number;
            cursor?: { date: string; id: string } | null;
            vesselId?: string;
            group?: string;
            state?: string;
            eventType?: string;
            schema?: string;
            dateFrom?: string;
            dateTo?: string;
            invalidatedOnly?: boolean;
            hasRemarks?: boolean;
            search?: string;
          };
          const parsed: {
            limit: number;
            cursor?: { date: string; id: string };
            vesselId?: string;
            group?: string;
            state?: string;
            eventType?: string;
            schema?: string;
            dateFrom?: string;
            dateTo?: string;
            invalidatedOnly?: boolean;
            hasRemarks?: boolean;
            search?: string;
          } = {
            limit: Math.min(Math.max(1, typeof v.limit === 'number' ? v.limit : 50), 200),
          };
          if (v.cursor && typeof v.cursor.date === 'string' && typeof v.cursor.id === 'string') {
            parsed.cursor = { date: v.cursor.date, id: v.cursor.id };
          }
          // Empty strings are what an unset <select> sends; treating them
          // as filters would match nothing and look like a broken page.
          for (const k of ['vesselId', 'group', 'state', 'eventType', 'schema', 'dateFrom', 'dateTo', 'search'] as const) {
            const raw = v[k];
            if (typeof raw === 'string' && raw.trim()) (parsed as Record<string, unknown>)[k] = raw.trim();
          }
          if (v.invalidatedOnly === true) parsed.invalidatedOnly = true;
          if (v.hasRemarks === true) parsed.hasRemarks = true;
          return parsed;
        })
        .query(async ({ input }) => {
          const { limit, cursor } = input;

          // Ports parseReportFilter (reports.go:234). Filters apply to the
          // deduplicated row — i.e. the report's *current* state — so
          // "show me invalidated reports" means the ones invalidated now,
          // not the ones that ever passed through that state.
          const conditions = [
            cursor ? sql`(l.received_at, l.report_id) < (${cursor.date}::timestamptz, ${cursor.id})` : null,
            input.vesselId ? sql`l.vessel_id = ${input.vesselId}::uuid` : null,
            input.state ? sql`l.state = ${input.state}` : null,
            input.eventType ? sql`l.event_type = ${input.eventType}` : null,
            input.schema ? sql`l.schema_kind = ${input.schema}` : null,
            // Matched against event_time, not received_at: the operator is
            // asking when something happened at sea, not when shore
            // happened to receive it — those differ by the whole length of
            // an outage.
            input.dateFrom ? sql`l.event_time >= ${input.dateFrom}::timestamptz` : null,
            input.dateTo ? sql`l.event_time <= ${input.dateTo}::timestamptz` : null,
            input.invalidatedOnly ? sql`l.state = 'invalidated'` : null,
            input.group ? sql`v.groups @> ${JSON.stringify([input.group])}::jsonb` : null,
            input.hasRemarks
              ? sql`EXISTS (SELECT 1 FROM remarks rm WHERE rm.vessel_id = l.vessel_id AND rm.report_id = l.report_id)`
              : null,
            input.search
              ? sql`(v.name ILIKE ${'%' + input.search + '%'} OR v.imo ILIKE ${'%' + input.search + '%'} OR l.report_id ILIKE ${'%' + input.search + '%'})`
              : null,
            // Typed predicate rather than `.filter(Boolean)`, which does
            // not narrow `T | null` away for sql.join.
          ].filter((c): c is SQL => c !== null);

          const where = conditions.length ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

          // Written as SQL rather than assembled in Drizzle's builder
          // because DISTINCT ON needs its own ORDER BY (by report identity)
          // that differs from the outer one (by recency) — expressing that
          // through the builder obscures the one thing worth reading here.
          const rows = await this.db.execute<{
            report_id: string;
            vessel_id: string;
            event_type: string;
            state: string;
            received_at: string;
            schema_kind: string;
            vessel_name: string | null;
            vessel_imo: string | null;
            reviewed_by: string | null;
          }>(sql`
            WITH latest AS (
              SELECT DISTINCT ON (rv.vessel_id, rv.report_id)
                rv.report_id, rv.vessel_id, rv.event_type, rv.state, rv.received_at,
                rv.event_time, rv.schema_kind
              FROM report_versions rv
              ORDER BY rv.vessel_id, rv.report_id, rv.version_no DESC
            )
            SELECT l.report_id, l.vessel_id, l.event_type, l.state, l.received_at,
                   l.schema_kind, v.name AS vessel_name, v.imo AS vessel_imo, rr.reviewed_by
            FROM latest l
            LEFT JOIN vessels v ON v.id = l.vessel_id
            LEFT JOIN report_reviews rr
              ON rr.vessel_id = l.vessel_id AND rr.report_id = l.report_id
            ${where}
            ORDER BY l.received_at DESC, l.report_id DESC
            LIMIT ${limit}
          `);

          const items = rows.rows.map((r) => ({
            id: r.report_id,
            vessel: r.vessel_name || 'Unknown',
            imo: r.vessel_imo || 'Unknown',
            type: r.event_type,
            status: r.state,
            date: new Date(r.received_at).toISOString().split('T')[0],
            by: 'System',
            reviewed: !!r.reviewed_by,
            schema: r.schema_kind,
            // Carried so the client can seek from the exact row it last
            // saw; the display `date` is truncated to a day and cannot.
            receivedAt: new Date(r.received_at).toISOString(),
          }));

          const last = rows.rows[rows.rows.length - 1];
          const nextCursor =
            items.length < limit || !last ? null : { date: new Date(last.received_at).toISOString(), id: last.report_id };

          return { items, nextCursor };
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
      /**
       * The report's chronological audit trail — ports
       * handleListReportEvents (reports.go:357), which had no equivalent
       * here: reports.get read a single 'submitted' row to get an author
       * name and nothing else, so B4's Audit trail tab had no data behind
       * it and a report's history was simply unavailable to a reviewer.
       *
       * `origin` distinguishes what the vessel reported from what office
       * did to it, which is the whole point of keeping the trail: a
       * dispute about a report turns on who changed what, and when.
       */
      listEvents: protectedProcedure
        .input((val: unknown) => {
          if (!ReportHistoryCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof ReportHistorySchema>;
        })
        .query(async ({ input }) => {
          const rows = await this.db
            .select({
              versionNo: schema.reportAuditEvents.versionNo,
              type: schema.reportAuditEvents.eventType,
              at: schema.reportAuditEvents.occurredAt,
              actor: schema.reportAuditEvents.actor,
              detail: schema.reportAuditEvents.detail,
              origin: schema.reportAuditEvents.origin,
            })
            .from(schema.reportAuditEvents)
            .where(
              and(
                eq(schema.reportAuditEvents.reportId, input.reportId),
                input.vesselId ? eq(schema.reportAuditEvents.vesselId, input.vesselId) : undefined,
              ),
            )
            // Ascending: a trail reads forwards. id breaks ties because
            // several events can share an instant (a submit and the
            // cascade it triggers), and an unstable order in an audit
            // view is worse than a wrong one — it changes between reads.
            .orderBy(schema.reportAuditEvents.occurredAt, schema.reportAuditEvents.id);

          return rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
        }),

      /**
       * Every version of one report, oldest first — ports
       * handleListReportVersions (reports.go:392), backing B4's History
       * tab. Without it a corrected report showed only its current state,
       * with no way to see what the correction actually changed.
       *
       * Field values travel with each version so the client can diff
       * consecutive versions without a request per version.
       */
      listVersions: protectedProcedure
        .input((val: unknown) => {
          if (!ReportHistoryCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof ReportHistorySchema>;
        })
        .query(async ({ input }) => {
          const rows = await this.db
            .select({
              versionNo: schema.reportVersions.versionNo,
              eventType: schema.reportVersions.eventType,
              state: schema.reportVersions.state,
              schemaKind: schema.reportVersions.schemaKind,
              eventTime: schema.reportVersions.eventTime,
              submittedAt: schema.reportVersions.submittedAt,
              receivedAt: schema.reportVersions.receivedAt,
              fields: schema.reportVersions.fields,
            })
            .from(schema.reportVersions)
            .where(
              and(
                eq(schema.reportVersions.reportId, input.reportId),
                input.vesselId ? eq(schema.reportVersions.vesselId, input.vesselId) : undefined,
              ),
            )
            .orderBy(schema.reportVersions.versionNo);

          return rows.map((v) => ({
            ...v,
            fields: (v.fields as Record<string, unknown>) ?? {},
            eventTime: v.eventTime ? new Date(v.eventTime).toISOString() : null,
            submittedAt: v.submittedAt ? new Date(v.submittedAt).toISOString() : null,
            receivedAt: v.receivedAt ? new Date(v.receivedAt).toISOString() : null,
          }));
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
      /**
       * What shore holds for one report — ports
       * handleListReportAttachments. Until attachments synced there was
       * nothing to list; now a reviewer can see the evidence a report
       * cites, and see honestly when it has not arrived yet.
       */
      listAttachments: protectedProcedure
        .input((val: unknown) => {
          if (!ListReportAttachmentsCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof ListReportAttachmentsSchema>;
        })
        .query(({ input }) => this.attachmentsService.listForReport(input.vesselId, input.reportId)),

      /**
       * Clears a whole selection at once — ports design handoff B3's bulk
       * "mark reviewed" (POST /api/reports/mark-reviewed).
       *
       * Reviewing is the office's daily grind: a night's worth of log
       * abstracts arrives together and is signed off together, and doing
       * that one request at a time meant a round trip per row.
       *
       * Reports that no longer exist are reported back rather than
       * failing the batch — a stale browser tab holding ids another admin
       * has since removed must not stop the rest being signed off.
       */
      bulkMarkReviewed: protectedProcedure
        .input((val: unknown) => {
          if (!BulkMarkReviewedCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof BulkMarkReviewedSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          const ids = Array.from(new Set(input.reportIds.filter(Boolean)));
          if (ids.length === 0) return { reviewed: 0, missing: [] as string[] };
          if (ids.length > BULK_REVIEW_LIMIT) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Too many reports in one request (limit ${BULK_REVIEW_LIMIT}).`,
            });
          }

          const localUser = await this.supertokensService.getLocalUser(ctx.session.getUserId());
          const reviewedBy = localUser?.username || 'unknown';
          const reviewedAt = new Date().toISOString();

          // One query to resolve every vessel id, not one per report:
          // report_reviews is keyed on (vesselId, reportId) and the
          // caller only sends report ids.
          const rows = await this.db
            .selectDistinct({
              reportId: schema.reportVersions.reportId,
              vesselId: schema.reportVersions.vesselId,
            })
            .from(schema.reportVersions)
            .where(inArray(schema.reportVersions.reportId, ids));

          const found = new Map(rows.map((r) => [r.reportId, r.vesselId]));
          const missing = ids.filter((id) => !found.has(id));
          if (found.size === 0) return { reviewed: 0, missing };

          await this.db
            .insert(schema.reportReviews)
            .values(
              Array.from(found, ([reportId, vesselId]) => ({ vesselId, reportId, reviewedBy, reviewedAt })),
            )
            .onConflictDoUpdate({
              target: [schema.reportReviews.vesselId, schema.reportReviews.reportId],
              set: { reviewedBy, reviewedAt },
            });

          return { reviewed: found.size, missing };
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
    apiKeys: router({
      // Admin-only, matching handleListAPIKeys (apikeys.go:44). Even
      // without the token itself, the list is an inventory of live fleet
      // credentials — labels, ages and fingerprints — and every mutation
      // beside it is admin-gated, so leaving the read open would just
      // hand a viewer the map.
      list: protectedProcedure.query(async ({ ctx }) => {
        await this.assertAdmin(ctx);
        // Columns listed explicitly rather than `select()`: the bare form
        // returns the whole row, which shipped tokenHash and
        // tokenLookupHash — hashes of live credentials — to every browser
        // that opened Settings. Same reasoning as PUBLIC_USER_COLUMNS on
        // the vessel side; a column added later has to be opted in rather
        // than leaking by default.
        const rows = await this.db
          .select({
            id: schema.apiKeys.id,
            label: schema.apiKeys.label,
            groupId: schema.apiKeys.groupId,
            createdBy: schema.apiKeys.createdBy,
            createdAt: schema.apiKeys.createdAt,
            lastUsedAt: schema.apiKeys.lastUsedAt,
            // A short, non-reversible fingerprint so keys stay tellable
            // apart in the UI. The plaintext token is unrecoverable by
            // design, and several keys legitimately share a label
            // ("Sync Key"), which previously left the list showing four
            // identical rows with no way to know which one to revoke.
            lookupHash: schema.apiKeys.tokenLookupHash,
          })
          .from(schema.apiKeys)
          .where(isNull(schema.apiKeys.revokedAt))
          // Without an explicit order Postgres is free to return these in
          // any sequence, and it does — the list reshuffled between
          // loads. Every row carries a Revoke button, so a list that
          // reorders under the pointer is a way to revoke the wrong key.
          .orderBy(desc(schema.apiKeys.createdAt));

        return rows.map(({ lookupHash, ...k }) => ({
          ...k,
          fingerprint: lookupHash.slice(0, 8),
        }));
      }),
      create: protectedProcedure
        .input((val: unknown) => {
          if (!CreateApiKeyCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof CreateApiKeySchema>;
        })
        .mutation(async ({ input, ctx }) => {
          await this.assertAdmin(ctx);
          const rawToken = crypto.randomBytes(32).toString('hex');
          const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
          const tokenLookupHash = crypto.createHash('sha256').update(rawToken.substring(0, 8)).digest('hex');
          
          const newKey = await this.db.insert(schema.apiKeys).values({
            label: input.label,
            tokenHash,
            tokenLookupHash,
            groupId: input.groupId || null,
            createdBy: 'System',
            createdAt: new Date().toISOString(),
          }).returning();

          await this.recordApiKeyEvent(newKey[0].id, 'created');

          return {
            key: newKey[0],
            rawToken: `ovl_prod_${rawToken}`,
          };
        }),
      /**
       * One key's activity log — ports handleListAPIKeyEvents. Not-found
       * on an unknown key rather than an empty list, so the screen can
       * tell "no activity yet" apart from "another admin deleted this".
       */
      listEvents: protectedProcedure
        .input((val: unknown) => {
          if (!RevokeApiKeyCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof RevokeApiKeySchema>;
        })
        .query(async ({ input, ctx }) => {
          await this.assertAdmin(ctx);
          const [key] = await this.db
            .select({ id: schema.apiKeys.id, lastUsedAt: schema.apiKeys.lastUsedAt })
            .from(schema.apiKeys)
            .where(eq(schema.apiKeys.id, input.id))
            .limit(1);
          if (!key) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such API key.' });

          const events = await this.db
            .select({ kind: schema.apiKeyEvents.kind, at: schema.apiKeyEvents.at })
            .from(schema.apiKeyEvents)
            .where(eq(schema.apiKeyEvents.apiKeyId, input.id))
            .orderBy(desc(schema.apiKeyEvents.at));

          return {
            // Usage is a column, not a stream of events — see touchApiKey.
            lastUsedAt: toIsoOrNull(key.lastUsedAt),
            events: events.map((e) => ({ kind: e.kind, at: toIso(e.at) })),
          };
        }),
      revoke: protectedProcedure
        .input((val: unknown) => {
          if (!RevokeApiKeyCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof RevokeApiKeySchema>;
        })
        .mutation(async ({ input, ctx }) => {
          await this.assertAdmin(ctx);
          await this.db
            .update(schema.apiKeys)
            .set({ revokedAt: new Date().toISOString() })
            .where(eq(schema.apiKeys.id, input.id));
          await this.recordApiKeyEvent(input.id, 'revoked');
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
      /**
       * A field's controlled vocabulary, so a form can offer the codes
       * instead of a free-text box the operator has to already know the
       * answers for.
       */
      /**
       * One schema's full version history. `list` only ever returns the
       * newest of each name, so nothing showed what a report filed last
       * month was actually validated against.
       */
      history: protectedProcedure
        .input((val: unknown) => {
          if (!SchemaHistoryCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof SchemaHistorySchema>;
        })
        .query(({ input }) => this.schemaVersionsService.history(input.schemaName)),

      /** One published version, parsed — the other half of a diff view. */
      getVersion: protectedProcedure
        .input((val: unknown) => {
          if (!SchemaVersionCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof SchemaVersionSchema>;
        })
        .query(async ({ input }) => {
          const version = await this.schemaVersionsService.getVersion(input.schemaName, input.version);
          if (!version) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such schema version.' });
          return version;
        }),

      getEnum: protectedProcedure
        .input((val: unknown) => {
          if (!GetEnumCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof GetEnumSchema>;
        })
        .query(({ input }) => this.schemaVersionsService.getEnum(input.enumRef)),
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
        .mutation(async ({ input, ctx }) => {
          await this.assertConfigManager(ctx);
          return this.schemaVersionsService.preview(input.schemaName, input.content);
        }),
      publish: protectedProcedure
        .input((val: unknown) => {
          if (!PublishSchemaCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof PublishSchemaSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          await this.assertConfigManager(ctx);
          return this.schemaVersionsService.publish(input);
        }),
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
      history: protectedProcedure
        .input((val: unknown) => {
          const v = (val ?? {}) as { limit?: number; cursor?: { publishedAt: string; id: string } | null };
          const parsed: { limit: number; cursor?: { publishedAt: string; id: string } } = {
            limit: Math.min(Math.max(1, typeof v.limit === 'number' ? v.limit : 25), 200),
          };
          if (v.cursor && typeof v.cursor.publishedAt === 'string' && typeof v.cursor.id === 'string') {
            parsed.cursor = { publishedAt: v.cursor.publishedAt, id: v.cursor.id };
          }
          return parsed;
        })
        .query(async ({ input }) => {
          const items = await this.configBundleService.history(input.limit, input.cursor);
          const last = items[items.length - 1];
          const nextCursor =
            items.length < input.limit || !last ? null : { publishedAt: last.publishedAt, id: last.id };
          return { items, nextCursor };
        }),
      preview: protectedProcedure.query(() => this.configBundleService.preview()),
      publish: protectedProcedure
        .input((val: unknown) => {
          if (!PublishConfigBundleCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof PublishConfigBundleSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          await this.assertConfigManager(ctx);
          return this.configBundleService.publish(input.label || '');
        }),
      assign: protectedProcedure
        .input((val: unknown) => {
          if (!AssignBundleCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof AssignBundleSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          await this.assertConfigManager(ctx);
          return this.configBundleService.assign(input.scope as Scope, input.bundleId);
        }),
      listAssignments: protectedProcedure.query(() => this.configBundleService.listAssignments()),
      vesselConfigs: protectedProcedure.query(() => this.configBundleService.vesselConfigs()),
      // Shore-side sync history. Optionally narrowed to one vessel; without a
      // filter it is the fleet's check-in log, which is where an unknown
      // vessel repeatedly failing to enrol becomes visible.
      /**
       * The check-in log. Filters, ordering and paging all live
       * server-side: this table grows by one row per vessel per cycle, so
       * a screen that filtered or sorted in the browser would be sorting
       * whatever page it happened to have.
       */
      syncHistory: protectedProcedure
        .input((val: unknown) => parseSyncHistoryInput(val))
        .query(async ({ input }) => {
          const items = await this.configBundleService.syncHistory(
            toSyncHistoryFilters(input),
            input.limit,
            input.cursor,
            input.sort,
          );
          // A short page means there is nothing after it, so the client
          // never makes an extra request just to discover the end.
          const last = items[items.length - 1];
          const nextCursor =
            items.length < input.limit || !last ? null : { receivedAt: last.receivedAt, id: last.id };
          return { items, nextCursor };
        }),

      /**
       * Aggregates over the same filtered set syncHistory returns, as a
       * separate call rather than riding on every page: the numbers
       * describe the whole match and only change when the filters do, so
       * recomputing them on each scroll would be wasted work.
       */
      syncMetrics: protectedProcedure
        .input((val: unknown) => toSyncHistoryFilters(parseSyncHistoryInput(val)))
        .query(({ input }) => this.configBundleService.syncMetrics(input)),

      /** Outcomes actually present, for building the filter controls. */
      syncOutcomes: protectedProcedure.query(() => this.configBundleService.syncOutcomes()),
    }),
    compliance: router({
      ruleCatalog: protectedProcedure.query(() => this.complianceService.ruleCatalog()),
      listProfiles: protectedProcedure.query(() => this.complianceService.listProfiles()),
      saveProfile: protectedProcedure
        .input((val: unknown) => {
          if (!SaveProfileAssignmentCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof SaveProfileAssignmentSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          await this.assertConfigManager(ctx);
          return this.complianceService.saveProfile(input.scope as Scope, input.profiles);
        }),
      listCadenceRules: protectedProcedure.query(() => this.complianceService.listCadenceRules()),
      saveCadenceRule: protectedProcedure
        .input((val: unknown) => {
          if (!SaveCadenceRuleCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof SaveCadenceRuleSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          await this.assertConfigManager(ctx);
          return this.complianceService.saveCadenceRule(input.scope as Scope, input.minReportIntervalHours, input.maxGapHours);
        }),
      listRuleSeverities: protectedProcedure.query(() => this.complianceService.listRuleSeverities()),
      saveRuleSeverity: protectedProcedure
        .input((val: unknown) => {
          if (!SaveRuleSeverityCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof SaveRuleSeveritySchema>;
        })
        .mutation(async ({ input, ctx }) => {
          await this.assertConfigManager(ctx);
          return this.complianceService.saveRuleSeverity(input.scope as Scope, input.severities);
        }),
    }),
  });
}

export type AppRouter = TrpcRouter['appRouter'];
