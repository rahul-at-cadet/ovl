import { TRPCError } from '@trpc/server';
import { Type, Static } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { auditMeta, protectedProcedure, requireCatalogue, requireTenant, router } from './trpc.base';
import { TenantRegistryService } from '../tenancy/tenant-registry.service';
import { TenantProvisioningService } from '../tenancy/tenant-provisioning.service';
import { TenantMigrationRunnerService } from '../tenancy/tenant-migration-runner.service';
import { PlatformDbService } from '../tenancy/platform-db.service';
import { TenantSelectionService } from '../tenancy/tenant-selection.service';
import { TenantSettingsService } from '../tenancy/tenant-settings.service';
import { SupertokensService } from '../auth/supertokens.service';
import { AuditService } from '../audit/audit.service';
import { tryCurrentTenant } from '../tenancy/tenant-context';

/**
 * Platform tenant administration — the top of the hierarchy.
 *
 * A super admin creates a tenant and its first office admin here; that admin
 * then creates the tenant's own office users, who register and manage its
 * vessels. Only this first step crosses tenant boundaries, which is why it is
 * the only router in the app gated on super admin rather than on a session's
 * resolved tenant.
 *
 * Every procedure delegates to the same services the `tenant` CLI drives
 * (TenantProvisioningService, TenantMigrationRunnerService, TenantRegistryService).
 * Nothing here reimplements provisioning: the CLI and this router must not be
 * able to drift, because a tenant built by one and migrated by the other would
 * differ in ways nobody would think to look for.
 *
 * Dependencies arrive as a getter; see notifications.router.ts for why.
 *
 * The services are optional because tenancy is only wired up when
 * MULTI_TENANCY_ENABLED is set — the procedures say so plainly rather than
 * failing to resolve a dependency at boot.
 */
export interface TenantsRouterDeps {
  platformDb?: PlatformDbService;
  registry?: TenantRegistryService;
  provisioning?: TenantProvisioningService;
  migrations?: TenantMigrationRunnerService;
  selection?: TenantSelectionService;
  settings?: TenantSettingsService;
  /** For the tenant-admin check on the settings procedures. */
  supertokens?: SupertokensService;
  audit?: AuditService;
}

const ProvisionSchema = Type.Object({
  name: Type.String(),
  // Derived from `name` when omitted, exactly as the CLI does it.
  slug: Type.Optional(Type.String()),
  // When given, the tenant's first office admin is created in the same call
  // and its one-time password is returned.
  adminEmail: Type.Optional(Type.String()),
});
const ProvisionCompiler = TypeCompiler.Compile(ProvisionSchema);

const UpdateTenantSettingsSchema = Type.Object({
  name: Type.Optional(Type.String()),
  // Explicitly nullable: null clears the logo, absent leaves it untouched, so
  // saving the General tab cannot blank a logo the form never carried.
  logoDataUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  defaultTimezone: Type.Optional(Type.String()),
});
const UpdateTenantSettingsCompiler = TypeCompiler.Compile(UpdateTenantSettingsSchema);

const SlugSchema = Type.Object({ slug: Type.String() });
const SetModeSchema = Type.Object({
  mode: Type.Union([Type.Literal('read'), Type.Literal('write')]),
});
const SetModeCompiler = TypeCompiler.Compile(SetModeSchema);
const SlugCompiler = TypeCompiler.Compile(SlugSchema);

const SetStatusSchema = Type.Object({
  slug: Type.String(),
  status: Type.Union([
    Type.Literal('active'),
    Type.Literal('suspended'),
    Type.Literal('archived'),
  ]),
});
const SetStatusCompiler = TypeCompiler.Compile(SetStatusSchema);

const CreateAdminSchema = Type.Object({
  slug: Type.String(),
  username: Type.String(),
});
const CreateAdminCompiler = TypeCompiler.Compile(CreateAdminSchema);

const DestroySchema = Type.Object({
  slug: Type.String(),
  /** Must be the exact string `drop tenant <slug>`; see TenantProvisioningService.destroy. */
  confirmation: Type.String(),
});
const DestroyCompiler = TypeCompiler.Compile(DestroySchema);

export function createTenantsRouter(deps: () => TenantsRouterDeps) {
  /** Throws unless tenancy is switched on for this deployment. */
  function require<T>(service: T | undefined, what: string): T {
    if (!service) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `${what} is unavailable because multi-tenancy is not enabled on this deployment.`,
      });
    }
    return service;
  }

  /**
   * The caller, having proved they are a platform super admin.
   *
   * Checked here to return a clean 403 at the edge. It is not the only guard:
   * provisioning runs on a separate administrative pool that ordinary requests
   * never touch, so a caller who somehow reached past this still has no role
   * that can CREATE SCHEMA.
   */
  async function requireSuperAdmin(ctx: { session: { getUserId(): string } }): Promise<string> {
    const platform = require(deps().platformDb, 'Tenant administration');
    const userId = ctx.session.getUserId();
    if (!(await platform.isSuperAdmin(userId))) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'This action requires a platform super admin.',
      });
    }
    return userId;
  }

  return router({
    /**
     * Whether this deployment can administer tenants at all, so the UI can say
     * "provisioning is not configured" instead of offering a button that
     * always fails. Deliberately not super-admin gated: it reveals nothing but
     * a deployment mode, and the page needs it in order to decide what to
     * render for a non-super-admin in the first place.
     */
    capabilities: protectedProcedure.query(async ({ ctx }) => {
      const d = deps();
      const isSuperAdmin = d.platformDb
        ? await d.platformDb.isSuperAdmin(ctx.session.getUserId())
        : false;
      // Which tenant this super admin is currently looking into. Ordinary
      // users always get null here: their tenant comes from their own
      // membership and is not something they choose.
      let viewing: Awaited<ReturnType<TenantSelectionService['current']>> = null;
      if (isSuperAdmin && d.selection?.enabled) {
        viewing = await d.selection.current(ctx.session.getUserId());
      }

      // Whose data this request is actually reading — the customer company,
      // not this product. Every screen in the office app belongs to exactly
      // one tenant and nothing on any of them said which, so a person with
      // access to two organisations had no way to tell them apart, and an
      // operator inside a customer's tenant had only the banner.
      //
      // Taken from the resolved context rather than from anything the caller
      // sent, for the same reason TenantMiddleware resolves it that way: this
      // is a label for the tenant the request is bound to, so it has to come
      // from the binding or it is decoration that can disagree with reality.
      const context = tryCurrentTenant();
      let tenant: { slug: string; name: string; logoDataUrl: string | null } | null = null;
      if (context && d.settings) {
        // Never fatal. The shell is chrome: if this lookup fails the app must
        // still render, unbranded, rather than the whole screen erroring
        // because a logo could not be read.
        const settings = await d.settings.get(context.tenantId).catch(() => null);
        tenant = {
          slug: context.slug,
          // Falls back to the slug, so a tenant is always identifiable.
          name: settings?.name ?? context.slug,
          logoDataUrl: settings?.logoDataUrl ?? null,
        };
      }

      return {
        tenancyEnabled: Boolean(d.platformDb),
        // Whether a tenant resolved for this request at all. The shell needs
        // it to tell two silences apart: an office user whose identity was
        // never mapped to a tenant sees the same empty tables as one whose
        // tenant is simply empty, and only the server knows which it is.
        hasTenant: Boolean(tryCurrentTenant()),
        // Provisioning needs ADMIN_DATABASE_URL — a role that may CREATE
        // SCHEMA and CREATE ROLE. A deployment can run multi-tenant without
        // it, and then tenants can be listed but not created.
        canProvision: Boolean(d.provisioning?.enabled),
        isSuperAdmin,
        tenant,
        viewing,
      };
    }),

    /**
     * This tenant's own settings — what Global Settings calls Company Name,
     * plus its logo and default timezone.
     *
     * Readable by any signed-in member of the tenant: the shell renders the
     * name and logo on every screen, so gating it on admin would leave
     * everyone else looking at an unbranded app.
     */
    settings: protectedProcedure.query(async () => {
      const tenant = requireTenant();
      return requireCatalogue(deps().settings).get(tenant.tenantId);
    }),

    /**
     * Edits them. Tenant admins only.
     *
     * The tenant is taken from the resolved context, never from the input, so
     * this cannot be pointed at another tenant however the caller frames the
     * request. What may be written is narrowed again underneath by a
     * column-level grant — see platform-bootstrap.sql section 11.
     */
    updateSettings: protectedProcedure
      .input((val: unknown) => {
        if (!UpdateTenantSettingsCompiler.Check(val)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid settings' });
        }
        return val as Static<typeof UpdateTenantSettingsSchema>;
      })
      .mutation(async ({ input, ctx }) => {
        const tenant = requireTenant();
        const d = deps();

        // Roles live in the tenant's own users table, so this is the same
        // check users.create makes rather than the super-admin one the rest of
        // this router uses: renaming the company is the tenant's own business.
        const localUser = await requireCatalogue(d.supertokens).getLocalUser(ctx.session.getUserId());
        if (!localUser || !(localUser.roles as string[]).includes('admin')) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only an administrator can change these settings.',
          });
        }

        const updated = await requireCatalogue(d.settings).update(tenant.tenantId, input);

        // Who renamed the company, and from what. Reconstructing that from the
        // new name alone is exactly what an audit trail exists to avoid.
        await d.audit?.record({
          event: 'tenant.settings_changed',
          actorUserId: ctx.session.getUserId(),
          actorEmail: localUser.username,
          subject: tenant.slug,
          detail: {
            changed: Object.keys(input),
            ...(input.name === undefined ? {} : { name: updated.name }),
            ...(input.defaultTimezone === undefined ? {} : { defaultTimezone: updated.defaultTimezone }),
            // Never the data URI itself — it would bloat every row and tells an
            // auditor nothing a boolean does not.
            ...(input.logoDataUrl === undefined ? {} : { logo: input.logoDataUrl ? 'set' : 'cleared' }),
          },
          ...auditMeta(ctx),
        });

        return updated;
      }),

    /**
     * Every tenant, with the migration state of its schema.
     *
     * The two are joined here rather than left as separate calls because a
     * tenant whose schema is behind is not a separate concern from the tenant
     * — it is the single most important thing to know about one, and a list
     * that omitted it would look healthy while a customer's vessels failed to
     * sync.
     */
    list: protectedProcedure.query(async ({ ctx }) => {
      await requireSuperAdmin(ctx);
      const registry = require(deps().registry, 'Tenant administration');

      const tenants = await registry.list();

      // Migration status is best-effort: it needs the administrative pool,
      // which a read-only deployment may not have. Losing it must not take
      // the whole list down with it.
      let statuses: Awaited<ReturnType<TenantMigrationRunnerService['status']>> = [];
      try {
        if (deps().migrations) statuses = await deps().migrations!.status();
      } catch {
        statuses = [];
      }
      const bySlug = new Map(statuses.map((s) => [s.slug, s]));

      return tenants.map((t) => {
        const m = bySlug.get(t.slug);
        return {
          tenantId: t.tenantId,
          slug: t.slug,
          name: t.name,
          schemaName: t.schemaName,
          status: t.status,
          appliedMigrations: m?.applied ?? [],
          pendingMigrations: m?.pending ?? [],
          // An applied migration whose file no longer matches what was
          // recorded. Surfaced rather than swallowed: it means the schema and
          // the migration history disagree, and no further migration will run
          // for that tenant until someone looks.
          driftedMigrations: m?.drifted ?? [],
        };
      });
    }),

    /** Creates a tenant, and optionally its first office admin, in one step. */
    provision: protectedProcedure
      .input((val: unknown) => {
        if (!ProvisionCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof ProvisionSchema>;
      })
      .mutation(async ({ input, ctx }) => {
        await requireSuperAdmin(ctx);
        const provisioning = require(deps().provisioning, 'Tenant provisioning');

        const tenant = await provisioning.provision({
          name: input.name,
          ...(input.slug ? { slug: input.slug } : {}),
        });

        // Reported separately from the tenant itself. Provisioning succeeded
        // even if creating the admin does not, and a caller told only "failed"
        // would try again and hit a slug that now exists.
        let admin: { username: string; temporaryPassword: string } | null = null;
        let adminError: string | null = null;
        if (input.adminEmail) {
          try {
            const created = await provisioning.createFirstAdmin(tenant, input.adminEmail);
            admin = {
              username: created.username,
              temporaryPassword: created.temporaryPassword,
            };
          } catch (err: any) {
            adminError = err?.message ?? String(err);
          }
        }

        return {
          tenantId: tenant.tenantId,
          slug: tenant.slug,
          name: input.name,
          schemaName: tenant.schemaName,
          admin,
          adminError,
        };
      }),

    /**
     * Adds an admin to an existing tenant. Named `createFirstAdmin` on the
     * service because that is its role in the hierarchy — the account that can
     * then create the rest of that tenant's office users.
     */
    createAdmin: protectedProcedure
      .input((val: unknown) => {
        if (!CreateAdminCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof CreateAdminSchema>;
      })
      .mutation(async ({ input, ctx }) => {
        await requireSuperAdmin(ctx);
        const provisioning = require(deps().provisioning, 'Tenant provisioning');
        const registry = require(deps().registry, 'Tenant administration');

        const tenant = await registry.forSlug(input.slug);
        if (!tenant) {
          throw new TRPCError({ code: 'NOT_FOUND', message: `No tenant with slug ${input.slug}.` });
        }
        const created = await provisioning.createFirstAdmin(tenant, input.username);
        return { username: created.username, temporaryPassword: created.temporaryPassword };
      }),

    /** Suspends, reactivates or archives a tenant. */
    setStatus: protectedProcedure
      .input((val: unknown) => {
        if (!SetStatusCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof SetStatusSchema>;
      })
      .mutation(async ({ input, ctx }) => {
        await requireSuperAdmin(ctx);
        const provisioning = require(deps().provisioning, 'Tenant administration');
        await provisioning.setStatus(input.slug, input.status);
        return { slug: input.slug, status: input.status };
      }),

    /**
     * Destroys a tenant and everything in it. Irreversible.
     *
     * The confirmation string is passed straight through to the service, which
     * re-checks it. Validating it only in the UI would put the guard on the
     * side of the wire that an operator can skip.
     */
    destroy: protectedProcedure
      .input((val: unknown) => {
        if (!DestroyCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof DestroySchema>;
      })
      .mutation(async ({ input, ctx }) => {
        await requireSuperAdmin(ctx);
        const provisioning = require(deps().provisioning, 'Tenant administration');
        await provisioning.destroy(input.slug, input.confirmation as `drop tenant ${string}`);
        return { slug: input.slug };
      }),

    /** Per-tenant migration state: applied, pending, and drifted. */
    migrationStatus: protectedProcedure.query(async ({ ctx }) => {
      await requireSuperAdmin(ctx);
      return require(deps().migrations, 'Tenant migrations').status();
    }),

    /** Applies every pending migration to every tenant. */
    migrateAll: protectedProcedure.mutation(async ({ ctx }) => {
      await requireSuperAdmin(ctx);
      return require(deps().migrations, 'Tenant migrations').migrateAll();
    }),

    /** Applies pending migrations to one tenant. */
    migrateTenant: protectedProcedure
      .input((val: unknown) => {
        if (!SlugCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof SlugSchema>;
      })
      .mutation(async ({ input, ctx }) => {
        await requireSuperAdmin(ctx);
        const registry = require(deps().registry, 'Tenant administration');
        const runner = require(deps().migrations, 'Tenant migrations');

        const tenant = await registry.forSlug(input.slug);
        if (!tenant) {
          throw new TRPCError({ code: 'NOT_FOUND', message: `No tenant with slug ${input.slug}.` });
        }
        const applied = await runner.migrateTenant(tenant);
        return { slug: input.slug, applied };
      }),

    /**
     * Points this super admin at one tenant, so every tenant-scoped screen —
     * users, vessels, reports — then shows that tenant's data.
     *
     * This is how a platform operator sees inside a customer's fleet without
     * being a member of it. The tenant is stored against their identity rather
     * than sent with each request; see TenantSelectionService for why that
     * distinction is load-bearing.
     */
    viewAs: protectedProcedure
      .input((val: unknown) => {
        if (!SlugCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof SlugSchema>;
      })
      .mutation(async ({ input, ctx }) => {
        const userId = await requireSuperAdmin(ctx);
        const selection = require(deps().selection, 'Tenant viewing');
        return selection.select(userId, input.slug, auditMeta(ctx));
      }),

    /**
     * Switches between looking and changing.
     *
     * Read is the default and where an operator spends nearly all their time.
     * Write is entered deliberately, lapses back after 30 minutes, and is
     * dropped entirely when the tenant in view changes.
     */
    setMode: protectedProcedure
      .input((val: unknown) => {
        if (!SetModeCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof SetModeSchema>;
      })
      .mutation(async ({ input, ctx }) => {
        const userId = await requireSuperAdmin(ctx);
        const selection = require(deps().selection, 'Tenant viewing');
        return selection.setMode(userId, input.mode, auditMeta(ctx));
      }),

    /** Returns this super admin to having no tenant in view. */
    stopViewing: protectedProcedure.mutation(async ({ ctx }) => {
      const userId = await requireSuperAdmin(ctx);
      const selection = require(deps().selection, 'Tenant viewing');
      await selection.clear(userId, auditMeta(ctx));
      return { cleared: true };
    }),

    /**
     * Granting and revoking super admin itself is deliberately absent.
     *
     * SuperAdminService states the reason plainly: promotion is an
     * out-of-band operation so that a compromised request path cannot
     * promote anyone, itself included. Exposing it here — even guarded by
     * `requireSuperAdmin` — would put the platform's highest privilege
     * behind exactly the surface that guarantee exists to bypass. Use the
     * `catalogue:grant-admin` CLI command.
     */
  });
}
