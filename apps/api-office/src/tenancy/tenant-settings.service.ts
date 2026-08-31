import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Pool, escapeIdentifier, type PoolClient } from 'pg';
import { eq } from 'drizzle-orm';
import { tenants, type PlatformDatabase } from '@ovl/database';
import { PG_POOL, PLATFORM_DB, TENANCY_OPTIONS, type ResolvedTenancyOptions } from './tenancy.constants';
import { TenantRegistryService } from './tenant-registry.service';

const SETTINGS_WRITER_ROLE = 'tenant_settings_writer';

/**
 * How much logo a page can reasonably carry inline.
 *
 * The logo is a data URI on the tenant row, so it is sent with the settings
 * response and rendered straight from it. 256KB of base64 is roughly 190KB of
 * image — generous for a wordmark, and small enough that it never becomes the
 * reason a page is slow. The bound is here rather than on the column because
 * it is a judgement about pages, not about what Postgres can store.
 */
const MAX_LOGO_DATA_URL_BYTES = 256 * 1024;

/**
 * Raster only, and deliberately.
 *
 * SVG is the obvious thing to want for a logo and is left out on purpose. An
 * SVG is a document: it can carry script and external references, and it is
 * only inert while it stays inside an `<img>`. That is true of how this is
 * rendered today, and it is exactly the sort of constraint that quietly stops
 * being true the day somebody inlines the markup to recolour it. Excluding it
 * costs a customer some sharpness at 2x and removes the question entirely.
 */
const ALLOWED_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export interface TenantSettings {
  /** The customer's own organisation name — what Global Settings calls Company Name. */
  name: string;
  logoDataUrl: string | null;
  defaultTimezone: string;
}

export interface TenantSettingsUpdate {
  name?: string;
  /** A data: URI, or null to clear the logo. Undefined leaves it alone. */
  logoDataUrl?: string | null;
  defaultTimezone?: string;
}

/**
 * A tenant's own identity settings: company name, logo, default timezone.
 *
 * These three are the only columns on `platform.tenants` a tenant may edit,
 * and the restriction is enforced by a column-level UPDATE grant rather than
 * by this class — see platform-bootstrap.sql section 11. `slug`,
 * `schema_name`, `role_name` and `status` decide which schema a tenant
 * resolves to and whether it resolves at all, so a bug here cannot reach them:
 * Postgres refuses, rather than a validation check somebody remembered to
 * write.
 *
 * Same dormant-membership pattern as the other elevated writers in this
 * module. `ovl_api` is a member of `tenant_settings_writer` and NOINHERIT, so
 * the privilege exists only inside the one transaction that applies an edit.
 *
 * Reads need no elevation — `ovl_api` can already SELECT the registry.
 */
@Injectable()
export class TenantSettingsService {
  private readonly logger = new Logger(TenantSettingsService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PLATFORM_DB) private readonly platformDb: PlatformDatabase,
    @Inject(TENANCY_OPTIONS) private readonly options: ResolvedTenancyOptions,
    private readonly registry: TenantRegistryService,
  ) {}

  /** The current settings for one tenant. */
  async get(tenantId: string): Promise<TenantSettings> {
    const rows = await this.platformDb
      .select({
        name: tenants.name,
        logoDataUrl: tenants.logoDataUrl,
        defaultTimezone: tenants.defaultTimezone,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const row = rows[0];
    if (!row) throw new NotFoundException('This account is not associated with a tenant.');
    return {
      name: row.name,
      logoDataUrl: row.logoDataUrl ?? null,
      defaultTimezone: row.defaultTimezone ?? 'UTC',
    };
  }

  /**
   * Applies an edit, and invalidates the registry so the new name reaches the
   * shell on the next request rather than after a cache TTL.
   *
   * Only the fields present in `update` are written, so saving the General tab
   * cannot blank a logo the form did not carry.
   */
  async update(tenantId: string, update: TenantSettingsUpdate): Promise<TenantSettings> {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (update.name !== undefined) {
      const name = update.name.trim();
      if (!name) throw new BadRequestException('Company name cannot be empty.');
      if (name.length > 120) {
        throw new BadRequestException('Company name cannot be longer than 120 characters.');
      }
      params.push(name);
      sets.push(`name = $${params.length}`);
    }

    if (update.logoDataUrl !== undefined) {
      const logo = update.logoDataUrl === null ? null : this.assertUsableLogo(update.logoDataUrl);
      params.push(logo);
      sets.push(`logo_data_url = $${params.length}`);
    }

    if (update.defaultTimezone !== undefined) {
      params.push(this.assertKnownTimezone(update.defaultTimezone));
      sets.push(`default_timezone = $${params.length}`);
    }

    if (sets.length === 0) return this.get(tenantId);

    params.push(tenantId);
    const client = await this.pool.connect();
    let bound = false;
    try {
      await this.bind(client);
      bound = true;

      const { rowCount } = await client.query(
        `UPDATE platform.tenants SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $${params.length}`,
        params,
      );
      if (rowCount === 0) {
        throw new NotFoundException('This account is not associated with a tenant.');
      }

      await client.query('COMMIT');
      client.release();
    } catch (error) {
      await this.rollbackAndRelease(client, bound);
      throw error;
    }

    // The shell shows the company name on every screen, so a rename that took
    // a cache TTL to appear would look like the save had failed.
    this.registry.invalidate();
    this.logger.log(`Updated settings for tenant ${tenantId}: ${Object.keys(update).join(', ')}`);
    return this.get(tenantId);
  }

  /**
   * Checks the logo is an image small enough to inline, and rejects anything
   * else — including a data URI that merely claims to be one.
   */
  private assertUsableLogo(dataUrl: string): string {
    const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl.trim());
    if (!match) {
      throw new BadRequestException(
        'The logo must be a base64 data URI. Pick the file again, or try a different image.',
      );
    }

    const [, mediaType, base64] = match;
    if (!ALLOWED_LOGO_TYPES.includes(mediaType.toLowerCase() as (typeof ALLOWED_LOGO_TYPES)[number])) {
      throw new BadRequestException(
        `${mediaType} is not a supported logo format. Use a PNG, JPEG, WebP or GIF.`,
      );
    }

    if (Buffer.byteLength(dataUrl, 'utf8') > MAX_LOGO_DATA_URL_BYTES) {
      throw new BadRequestException(
        `That logo is too large. Use an image under ${Math.floor(MAX_LOGO_DATA_URL_BYTES / 1024)}KB.`,
      );
    }

    // The declared type is a claim by the caller; the magic bytes are the
    // file. A mismatch is not necessarily an attack — browsers get this wrong
    // for renamed files — but storing it would put a broken image on every
    // screen with no clue why.
    const head = Buffer.from(base64.slice(0, 32), 'base64');
    if (!looksLikeImage(head)) {
      throw new BadRequestException('That file does not look like an image. Try a different one.');
    }

    return dataUrl.trim();
  }

  /**
   * Accepts only zones this runtime actually knows.
   *
   * Checked by asking Intl rather than against a list kept here, because the
   * zone database changes — countries add and drop them — and a hardcoded list
   * would start rejecting valid zones the moment Node updated underneath it.
   */
  private assertKnownTimezone(timezone: string): string {
    const value = timezone.trim();
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
    } catch {
      throw new BadRequestException(`"${timezone}" is not a recognised timezone.`);
    }
    return value;
  }

  /**
   * Same preamble as the other elevated writers, and verified the same way:
   * `SET LOCAL ROLE` outside a transaction silently does nothing, and ovl_api
   * can already SELECT this table, so an unbound connection would fail on the
   * UPDATE rather than obviously.
   */
  private async bind(client: PoolClient): Promise<void> {
    const timeout = Number(this.options.statementTimeoutMillis);
    const preamble = [
      'BEGIN',
      `SET LOCAL ROLE ${escapeIdentifier(SETTINGS_WRITER_ROLE)}`,
      'SET LOCAL search_path TO platform',
      timeout > 0 ? `SET LOCAL statement_timeout = ${timeout}` : null,
      'SELECT current_user AS bound_role',
    ]
      .filter(Boolean)
      .join('; ');

    const results = (await client.query(preamble)) as unknown as Array<{
      rows: Array<{ bound_role: string }>;
    }>;
    const verification = Array.isArray(results) ? results[results.length - 1] : results;
    const observed = verification?.rows?.[0]?.bound_role;

    if (observed !== SETTINGS_WRITER_ROLE) {
      throw new Error(
        `Refusing to write tenant settings: expected role ${SETTINGS_WRITER_ROLE}, connection ` +
          `reports ${observed}. Re-run packages/database/bootstrap/platform-bootstrap.sql — it ` +
          `is idempotent, and section 11 creates this role and grants it to ovl_api.`,
      );
    }
  }

  private async rollbackAndRelease(client: PoolClient, bound: boolean): Promise<void> {
    if (!bound) {
      client.release(true);
      return;
    }
    try {
      await client.query('ROLLBACK');
      client.release();
    } catch {
      client.release(true);
    }
  }
}

/** Magic bytes for the formats ALLOWED_LOGO_TYPES permits. */
function looksLikeImage(head: Buffer): boolean {
  const startsWith = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
  return (
    startsWith(0x89, 0x50, 0x4e, 0x47) || // PNG
    startsWith(0xff, 0xd8, 0xff) || // JPEG
    startsWith(0x47, 0x49, 0x46, 0x38) || // GIF87a / GIF89a
    (startsWith(0x52, 0x49, 0x46, 0x46) && head.subarray(8, 12).toString('ascii') === 'WEBP')
  );
}
