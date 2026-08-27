import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Pool, escapeIdentifier, escapeLiteral } from 'pg';
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

export interface ProvisionTenantInput {
  /** URL-safe key. Derived from `name` when omitted. */
  slug?: string;
  /** Display name, e.g. "Northstar Shipping". */
  name: string;
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
  ) {}

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
    const sqlPath = join(packageRoot, 'bootstrap', 'fresh-database.sql');
    return readFileSync(sqlPath, 'utf8').replaceAll('"public".', '');
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
