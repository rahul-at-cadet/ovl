import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Pool } from 'pg';
import { ADMIN_PG_POOL } from './tenancy.constants';
import { PlatformDbService } from './platform-db.service';
import { ProvisioningDisabledError } from './tenant-provisioning.service';

export interface SuperAdminRecord {
  supertokensUserId: string;
  email: string;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
}

/**
 * Grants and revokes platform super admin.
 *
 * Runs on the elevated pool, not the serving one. `ovl_api` can *read*
 * `platform.super_admins` — it has to, since every catalogue write checks it —
 * but cannot write it. That asymmetry is the point: promotion is an out-of-band
 * operation, so a compromised request path cannot promote anyone, itself
 * included. There is deliberately no HTTP or tRPC route that reaches this
 * service; membership changes go through the CLI.
 */
@Injectable()
export class SuperAdminService {
  private readonly logger = new Logger(SuperAdminService.name);

  constructor(
    @Optional() @Inject(ADMIN_PG_POOL) private readonly adminPool: Pool | null,
    private readonly platform: PlatformDbService,
  ) {}

  async list(): Promise<SuperAdminRecord[]> {
    const pool = this.requirePool();
    const { rows } = await pool.query<SuperAdminRecord>(
      `SELECT supertokens_user_id AS "supertokensUserId", email, note,
              created_at AS "createdAt", created_by AS "createdBy"
         FROM platform.super_admins
        ORDER BY created_at`,
    );
    return rows;
  }

  async grant(
    supertokensUserId: string,
    email: string,
    options: { note?: string; grantedBy?: string } = {},
  ): Promise<void> {
    const pool = this.requirePool();
    await pool.query(
      `INSERT INTO platform.super_admins (supertokens_user_id, email, note, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (supertokens_user_id)
       DO UPDATE SET email = EXCLUDED.email, note = EXCLUDED.note`,
      [supertokensUserId, email, options.note ?? null, options.grantedBy ?? 'cli'],
    );

    // Without this the new admin waits out a cache TTL before the API agrees.
    this.platform.invalidateSuperAdmins();
    this.logger.log(`Granted platform super admin to ${email} (${supertokensUserId})`);
  }

  async revoke(supertokensUserId: string): Promise<boolean> {
    const pool = this.requirePool();
    const { rowCount } = await pool.query(
      `DELETE FROM platform.super_admins WHERE supertokens_user_id = $1`,
      [supertokensUserId],
    );

    // Invalidated immediately rather than left to expire: a revoked admin
    // keeping publish rights for another TTL is the wrong way round to fail.
    this.platform.invalidateSuperAdmins();
    if (rowCount) this.logger.warn(`Revoked platform super admin from ${supertokensUserId}`);
    return (rowCount ?? 0) > 0;
  }

  private requirePool(): Pool {
    if (!this.adminPool) throw new ProvisioningDisabledError();
    return this.adminPool;
  }
}
