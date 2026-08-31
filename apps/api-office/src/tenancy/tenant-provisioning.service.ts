import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Pool, escapeIdentifier, escapeLiteral, type PoolClient } from 'pg';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ADMIN_PG_POOL } from './tenancy.constants';
import {
  assertValidTenantSlug,
  roleNameForSlug,
  schemaNameForSlug,
  slugify,
} from './tenant-identifiers';
import { TenantRegistryService, type TenantDescriptor } from './tenant-registry.service';
import { runAsSystemForTenant } from './tenant-context';
import { UsersService } from '../users/users.service';
import supertokens from 'supertokens-node';
import { TenantMigrationRunnerService } from './tenant-migration-runner.service';

export interface ProvisionTenantInput {
  /** URL-safe key. Derived from `name` when omitted. */
  slug?: string;
  /** Display name, e.g. "Northstar Shipping". */
  name: string;
}

export interface FirstAdminResult {
  username: string;
  temporaryPassword: string;
  supertokensUserId: string;
}

/**
 * Thrown when a platform super admin is put forward as a tenant user.
 *
 * The mirror of `AlreadyATenantMemberError` in `SuperAdminService`: the rule is
 * enforced from both directions so it cannot be reached by doing the two steps
 * in the other order. See `apps/api-office/src/tenancy/README.md`, "Super
 * admins belong to no tenant".
 */
export class AlreadyASuperAdminError extends Error {
  constructor(identity: string, slug: string) {
    super(
      `Refusing to add ${identity} to tenant ${slug}: they are a platform super admin, and a ` +
        'super admin belongs to no tenant. A super admin reaches a tenant by selecting it, ' +
        'not by joining it. Revoke the grant first (npm run catalogue:revoke-admin), or use a ' +
        'separate identity for the tenant account.',
    );
    this.name = 'AlreadyASuperAdminError';
  }
}

export class ProvisioningDisabledError extends Error {
  constructor() {
    super(
      'Tenant provisioning is disabled: no adminConnectionString was configured. ' +
        'This is the correct default for a serving API process — run provisioning from ' +
        'the CLI (npm run tenant:provision) or a dedicated admin deployment.',
    );
    this.name = 'ProvisioningDisabledError';
  }
}

/**
 * Creates and dismantles tenants.
 *
 * Runs on a *separate, elevated* pool. The serving pool logs in as `ovl_api`,
 * which cannot CREATE SCHEMA, CREATE ROLE or GRANT — deliberately, so that a
 * bug on a request path cannot manufacture privileges for itself. Provisioning
 * is a different job with different rights, and it is disabled outright unless
 * an admin connection string is supplied.
 *
 * Every tenant ends up with the same three things: a schema, a role that owns
 * that schema, and a membership grant that lets `ovl_api` assume the role. The
 * role owning the schema is what makes the rest of the model simple — there
 * are no per-table grants to keep in step, and any table added by a later
 * migration is owned correctly by construction.
 */
@Injectable()
export class TenantProvisioningService {
  private readonly logger = new Logger(TenantProvisioningService.name);

  constructor(
    @Optional() @Inject(ADMIN_PG_POOL) private readonly adminPool: Pool | null,
    private readonly registry: TenantRegistryService,
    private readonly migrations: TenantMigrationRunnerService,
    private readonly users: UsersService,
  ) {}

  /**
   * Creates a tenant's first administrator.
   *
   * This is how a tenant gets its first account, and the only way it can: user
   * creation is otherwise done by an authenticated tenant admin, and at
   * registration time no such person exists yet. A platform super admin makes
   * the first one when the tenant is registered.
   *
   * The password is generated, returned once, and the account is flagged
   * mustChangePassword — so the operator hands over a credential that stops
   * working the moment it is used. Nothing durable is written anywhere that
   * would let it be recovered later, which is the point.
   *
   * Runs inside the tenant's own context, so the profile lands in that tenant's
   * schema — and so `UsersService.createUser` writes the platform mapping for
   * the tenant this context names.
   *
   * That mapping used to be written here instead, on the admin pool, because
   * `createUser` did not write it at all. It does now, for every account rather
   * than only this one, which was the bug: an office admin creating a colleague
   * produced an identity that authenticated and then resolved to no tenant.
   * Repeating the INSERT here would be idempotent and pointless — worse, it
   * would hide a broken grant on the path every *other* account takes, since
   * provisioning would keep succeeding while ordinary creation failed.
   */
  async createFirstAdmin(
    tenant: TenantDescriptor,
    username: string,
  ): Promise<FirstAdminResult> {
    // Not used here any more, but still required: provisioning stays disabled
    // in a process with no admin connection, and creating a tenant's first
    // administrator is provisioning.
    this.requirePool();

    // Before the profile is written, not after. This method creates a row in
    // the tenant's schema and then maps it in the registry; refusing at the
    // second step would leave an orphaned local profile behind that nothing
    // can sign in as and nothing cleans up.
    //
    // Matched on email as well as identity because the SuperTokens account may
    // not exist yet — an operator inviting `ops@example.com` to a tenant when
    // that address is already a platform super admin is the case this catches.
    const existing = await supertokens.listUsersByAccountInfo('public', { email: username });
    await this.assertNotASuperAdmin(
      { supertokensUserId: existing[0]?.id ?? null, email: username },
      tenant.slug,
    );

    // Before the profile is written, not after. This method creates a row in
    // the tenant's schema and then maps it in the registry; refusing at the
    // second step would leave an orphaned local profile behind that nothing
    // can sign in as and nothing cleans up.
    //
    // Matched on email as well as identity because the SuperTokens account may
    // not exist yet — an operator inviting `ops@example.com` to a tenant when
    // that address is already a platform super admin is the case this catches.
    const existing = await supertokens.listUsersByAccountInfo('public', { email: username });
    await this.assertNotASuperAdmin(
      { supertokensUserId: existing[0]?.id ?? null, email: username },
      tenant.slug,
    );

    const created = await runAsSystemForTenant({ ...tenant, requestId: 'provision-admin' }, () =>
      this.users.createUser({ username, roles: ['admin'] as never }),
    );

    this.logger.log(`Created first admin ${username} for tenant ${tenant.slug}`);
    return {
      username,
      temporaryPassword: created.temporaryPassword,
      supertokensUserId: created.supertokensUserId,
    };
  }

  get enabled(): boolean {
    return this.adminPool !== null;
  }

  /**
   * Creates a tenant end to end: role, schema, tables, registry row.
   *
   * One transaction for the whole thing. Postgres has transactional DDL, so a
   * failure half way through leaves no orphaned schema and no dangling role —
   * which matters, because a half-built tenant that still resolves is exactly
   * the state that serves empty or partial data to a real customer. The
   * registry row is written as `provisioning` and only flipped to `active` on
   * the last statement, so even a crash at COMMIT time cannot expose one.
   */
  async provision(input: ProvisionTenantInput, apiRoleName = 'ovl_api'): Promise<TenantDescriptor> {
    const pool = this.requirePool();

    const slug = input.slug ?? slugify(input.name);
    assertValidTenantSlug(slug);
    assertValidTenantRoleNameForApi(apiRoleName);

    const schemaName = schemaNameForSlug(slug);
    const roleName = roleNameForSlug(slug);

    const schemaIdent = escapeIdentifier(schemaName);
    const roleIdent = escapeIdentifier(roleName);
    const apiRoleIdent = escapeIdentifier(apiRoleName);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // NOLOGIN: this role is a privilege container, never a way in. Only
      // `ovl_api` authenticates, and only it can assume this role.
      await client.query(`
        DO $ovl$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${escapeLiteral(roleName)}) THEN
            EXECUTE 'CREATE ROLE ${roleIdent} NOLOGIN';
          END IF;
        END
        $ovl$;
      `);

      // The provisioning role must be able to SET ROLE into the new role in
      // order to create the tables as their eventual owner. A superuser can
      // already do this; a delegated admin needs the membership.
      await client.query(`GRANT ${roleIdent} TO CURRENT_USER`);

      // AUTHORIZATION is what makes the tenant role the schema owner, and
      // therefore the owner of everything created inside it later.
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaIdent} AUTHORIZATION ${roleIdent}`);

      // The membership that TenantDbService's `SET LOCAL ROLE` depends on.
      // Dormant until then, because ovl_api is NOINHERIT.
      await client.query(`GRANT ${roleIdent} TO ${apiRoleIdent}`);

      // Read-only access to the master form-schema catalogue, granted as a role
      // membership rather than as direct table GRANTs.
      //
      // Direct GRANTs do not work here and fail *silently*: provisioning runs as
      // ovl_admin, which does not own the `platform` schema and so has no grant
      // option on it. PostgreSQL answers that with `WARNING: no privileges were
      // granted` and commits anyway — the statements ran, reported no error, and
      // granted nothing. The membership works because bootstrap gives ovl_admin
      // ADMIN OPTION on this role, and it keeps one definition of "may read the
      // catalogue" instead of a list that drifts out of step with the tables.
      await client.query(`GRANT tenant_catalogue_reader TO ${roleIdent}`);

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO platform.tenants (slug, name, schema_name, role_name, status)
         VALUES ($1, $2, $3, $4, 'provisioning')
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
         RETURNING id`,
        [slug, input.name, schemaName, roleName],
      );
      const tenantId = inserted.rows[0].id;

      // Create the tables as the tenant role, inside the tenant schema. Both
      // settings are transaction-scoped, so they cannot escape onto the
      // connection when it goes back to the pool.
      await client.query(`SET LOCAL ROLE ${roleIdent}`);
      await client.query(`SET LOCAL search_path TO ${schemaIdent}`);
      await client.query(this.templateDdl());
      await client.query('RESET ROLE');

      // A new tenant is built from the template *plus every migration*, so it
      // lands on the same shape an existing tenant reaches by migrating. Then
      // the whole set is recorded as applied — without that, the next fan-out
      // would try to run them again against objects that already exist.
      await this.migrations.recordBaseline(client, tenantId);

      await this.assertCatalogueReadable(client, roleName);

      await client.query(
        `UPDATE platform.tenants SET status = 'active', updated_at = now() WHERE id = $1`,
        [tenantId],
      );

      await client.query('COMMIT');
      this.registry.invalidate();

      this.logger.log(`Provisioned tenant ${slug} (schema ${schemaName}, role ${roleName})`);
      return { tenantId, slug, schemaName, roleName };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Points an authenticated identity at a tenant. */
  async assignUser(supertokensUserId: string, tenantId: string): Promise<void> {
    const pool = this.requirePool();

    // The other half of the rule enforced in SuperAdminService.grant. Without
    // it, `tenant:assign` would be a way to construct exactly the combination
    // that promotion refuses to create.
    const tenant = await this.registry.byId(tenantId);
    await this.assertNotASuperAdmin({ supertokensUserId }, tenant?.slug ?? tenantId);

    await pool.query(
      `INSERT INTO platform.tenant_users (supertokens_user_id, tenant_id)
       VALUES ($1, $2)
       ON CONFLICT (supertokens_user_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id`,
      [supertokensUserId, tenantId],
    );
    this.registry.invalidate();
  }

  /**
   * Stops a tenant resolving, without touching its data.
   *
   * The reversible half of offboarding, and the one to reach for first.
   * Suspension takes effect within one registry cache TTL; call
   * `registry.invalidate()` — as this does — to make it immediate.
   */
  async setStatus(slug: string, status: 'active' | 'suspended' | 'archived'): Promise<void> {
    const pool = this.requirePool();
    await pool.query(
      `UPDATE platform.tenants SET status = $2, updated_at = now() WHERE slug = $1`,
      [slug, status],
    );
    this.registry.invalidate();
  }

  /**
   * Destroys a tenant: schema, role, registry row and all data.
   *
   * Irreversible, and guarded behind an explicit confirmation argument rather
   * than a boolean flag, so that a mistyped call cannot drop a customer.
   * Intended for test fixtures and for offboarding that has already been
   * through `setStatus('archived')` and a backup.
   */
  async destroy(slug: string, confirmation: `drop tenant ${string}`): Promise<void> {
    const pool = this.requirePool();
    assertValidTenantSlug(slug);

    if (confirmation !== `drop tenant ${slug}`) {
      throw new Error(
        `Refusing to destroy tenant ${slug}: confirmation must be the exact string "drop tenant ${slug}"`,
      );
    }

    const schemaIdent = escapeIdentifier(schemaNameForSlug(slug));
    const roleIdent = escapeIdentifier(roleNameForSlug(slug));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DROP SCHEMA IF EXISTS ${schemaIdent} CASCADE`);
      await client.query(`DROP ROLE IF EXISTS ${roleIdent}`);
      await client.query(`DELETE FROM platform.tenants WHERE slug = $1`, [slug]);
      await client.query('COMMIT');
      this.registry.invalidate();
      this.logger.warn(`Destroyed tenant ${slug}`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Proves the new tenant role can actually read the master catalogue.
   *
   * Checked rather than assumed because the failure mode here is silent: a
   * GRANT issued without grant option emits a warning and commits, so the
   * privileges can be absent while every statement reported success. A tenant
   * provisioned in that state looks healthy and then shows an empty schema
   * picker to real users.
   *
   * Runs inside the provisioning transaction, so a failure rolls the whole
   * tenant back rather than leaving a half-privileged one registered.
   */
  private async assertCatalogueReadable(client: PoolClient, roleName: string): Promise<void> {
    const { rows } = await client.query<{ usage: boolean; select: boolean }>(
      `SELECT has_schema_privilege($1, 'platform', 'USAGE') AS usage,
              has_table_privilege($1, 'platform.form_schema_versions', 'SELECT') AS select`,
      [roleName],
    );

    const result = rows[0];
    if (!result?.usage || !result?.select) {
      throw new Error(
        `Tenant role ${roleName} cannot read the master form-schema catalogue ` +
          `(USAGE=${result?.usage}, SELECT=${result?.select}). The membership grant did not ` +
          `take effect — check that platform-bootstrap.sql has been run and that it granted ` +
          `tenant_catalogue_reader TO ovl_admin WITH ADMIN OPTION.`,
      );
    }
  }

  /**
   * The DDL that defines a fresh tenant schema.
   *
   * Reuses `@ovl/database`'s existing single-tenant bootstrap rather than
   * maintaining a second copy that would drift. That file declares tables
   * unqualified, so it lands wherever `search_path` points — except for its
   * foreign keys, which drizzle-kit emitted as `REFERENCES "public"."x"`.
   * Left alone, every tenant's tables would carry foreign keys pointing into
   * `public`: a genuine cross-schema reference, and a provisioning run that
   * fails outright once `public` is empty.
   *
   * The qualification is stripped rather than rewritten to the tenant schema.
   * Stripping lets the reference resolve through `search_path` like every
   * other name in the file, and keeps tenant identifiers out of SQL text
   * assembled by string substitution.
   */
  private templateDdl(): string {
    const packageRoot = dirname(require.resolve('@ovl/database/package.json'));

    // The baseline, then every migration in order — the same sequence an
    // existing tenant reaches by being migrated, so both paths converge on one
    // shape. A change is written once, as a migration, rather than twice (in
    // the template for new tenants and again as a migration for existing ones),
    // which is exactly how the two drift apart.
    //
    // fresh-database.sql is drizzle-kit output and hard-qualifies its foreign
    // keys as `REFERENCES "public"."x"`. Left alone, every tenant's tables
    // would carry foreign keys pointing into `public` — a real cross-schema
    // reference. Stripping the qualification lets them resolve through
    // search_path like every other name in the file.
    const core = readFileSync(
      join(packageRoot, 'bootstrap', 'fresh-database.sql'),
      'utf8',
    ).replaceAll('"public".', '');

    return `${core}\n;\n${this.migrations.combinedSql()}`;
  }

  /**
   * Refuses an identity that is already a platform super admin.
   *
   * Either half of the identity is enough to match: the SuperTokens id when
   * the account exists, the email when it does not yet. `platform.super_admins`
   * stores both, so one query settles it.
   */
  private async assertNotASuperAdmin(
    identity: { supertokensUserId?: string | null; email?: string | null },
    slug: string,
  ): Promise<void> {
    const pool = this.requirePool();
    const { rows } = await pool.query<{ supertokens_user_id: string; email: string }>(
      `SELECT supertokens_user_id, email
         FROM platform.super_admins
        WHERE ($1::text IS NOT NULL AND supertokens_user_id = $1)
           OR ($2::text IS NOT NULL AND lower(email) = lower($2))
        LIMIT 1`,
      [identity.supertokensUserId ?? null, identity.email ?? null],
    );
    if (rows[0]) {
      throw new AlreadyASuperAdminError(identity.email ?? rows[0].supertokens_user_id, slug);
    }
  }

  private requirePool(): Pool {
    if (!this.adminPool) throw new ProvisioningDisabledError();
    return this.adminPool;
  }
}

/** The login role the API uses. Same character class as tenant roles, no prefix requirement. */
function assertValidTenantRoleNameForApi(roleName: string): void {
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(roleName)) {
    throw new Error(`Refusing to use API role name ${JSON.stringify(roleName)}`);
  }
}
