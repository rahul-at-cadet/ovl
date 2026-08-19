import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, isNull, desc } from 'drizzle-orm';
import * as schema from '@ovl/database';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as crypto from 'crypto';

export interface VesselUserCheckIn {
  username: string;
  role: string;
  active: boolean;
  canSubmit: boolean;
  updatedAt: string;
}

// Mirrors ovl/vessel/auth.GenerateTemporaryPassword — office chooses the
// temporary password (architecture 9.2's "no fleet-wide default passwords
// ever"), same as the vessel's own local user-creation path.
function generateTemporaryPassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join('');
}

// user_commands.seq is a Postgres bigserial, which Drizzle surfaces as a
// JS BigInt — JSON.stringify (and therefore tRPC's response serializer)
// throws on a raw BigInt, so every command row crossing the wire gets its
// seq downgraded to a string here rather than passed through raw.
function serializeCommand<T extends { seq: bigint }>(row: T): Omit<T, 'seq'> & { seq: string } {
  return { ...row, seq: row.seq.toString() };
}

/**
 * Remote vessel-user administration (architecture 9.3/12.4, ported from
 * ovl/office/httpapi/vesselusers.go + ovl/vessel/httpapi/usercommands.go).
 * A vessel is occasionally-connected, so office can never write to its
 * local user table directly — every action here queues a UserCommand row
 * instead, which the vessel pulls and applies on its own next sync cycle
 * (see apps/api-vessel/src/sync/sync.service.ts). The vessel's full
 * current roster is mirrored back into vessel_users on every check-in
 * (handleCheckIn), replaced wholesale — office's only visibility into who
 * actually exists on a vessel.
 */
@Injectable()
export class VesselUsersService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async listRoster(vesselId: string) {
    return this.db
      .select()
      .from(schema.vesselUsers)
      .where(eq(schema.vesselUsers.vesselId, vesselId));
  }

  async listCommands(vesselId: string) {
    const rows = await this.db
      .select()
      .from(schema.userCommands)
      .where(eq(schema.userCommands.vesselId, vesselId))
      .orderBy(desc(schema.userCommands.seq));
    return rows.map(serializeCommand);
  }

  /**
   * Master is created once, during the vessel's own local setup wizard —
   * never remotely. Refused here at queue time (defense in depth; the
   * vessel independently re-checks this on apply, since it's the final
   * authority over its own accounts).
   */
  private assertNotMaster(role: string) {
    if (role.toLowerCase() === 'master') {
      throw new BadRequestException('The Master account is created during vessel setup, not created remotely.');
    }
  }

  async queueCreate(vesselId: string, username: string, role: string, issuedBy: string) {
    this.assertNotMaster(role);
    const temporaryPassword = generateTemporaryPassword();
    const command = await this.queue(vesselId, 'create', { username, role, temporaryPassword, issuedBy });
    return { command, temporaryPassword };
  }

  async queueResetPassword(vesselId: string, username: string, issuedBy: string) {
    const temporaryPassword = generateTemporaryPassword();
    const command = await this.queue(vesselId, 'resetPassword', { username, temporaryPassword, issuedBy });
    return { command, temporaryPassword };
  }

  async queueSetRole(vesselId: string, username: string, role: string, issuedBy: string) {
    this.assertNotMaster(role);
    return this.queue(vesselId, 'setRole', { username, role, issuedBy });
  }

  async queueSetActive(vesselId: string, username: string, active: boolean, issuedBy: string) {
    return this.queue(vesselId, 'setActive', { username, active, issuedBy });
  }

  async queueSetCanSubmit(vesselId: string, username: string, canSubmit: boolean, issuedBy: string) {
    return this.queue(vesselId, 'setCanSubmit', { username, canSubmit, issuedBy });
  }

  private async queue(
    vesselId: string,
    action: string,
    opts: { username: string; role?: string; temporaryPassword?: string; canSubmit?: boolean; active?: boolean; issuedBy: string },
  ) {
    const rows = await this.db
      .insert(schema.userCommands)
      .values({
        id: crypto.randomUUID(),
        vesselId,
        action,
        username: opts.username,
        role: opts.role ?? '',
        temporaryPassword: opts.temporaryPassword ?? '',
        canSubmit: opts.canSubmit ?? false,
        active: opts.active ?? false,
        issuedBy: opts.issuedBy,
        issuedAt: new Date().toISOString(),
      })
      .returning();
    return serializeCommand(rows[0]);
  }

  /**
   * The pull-side of sync.pullConfig's check-in piggyback (see that
   * procedure's own comment): replaces the vessel's mirrored roster
   * wholesale (not merged — a since-deleted local account shouldn't
   * linger forever), marks any command IDs the vessel confirms it applied
   * since its last check-in, then returns every command still
   * outstanding (appliedAt IS NULL) for the vessel to apply this cycle.
   * Returned, not yet-acked commands stay outstanding and are
   * re-delivered on the next check-in — safer than a fetched-once flag,
   * since a vessel that crashes mid-apply must still see the command
   * again rather than silently lose it.
   */
  async handleCheckIn(vesselId: string, users: VesselUserCheckIn[] | undefined, appliedCommandIds: string[] | undefined) {
    const now = new Date().toISOString();

    if (users) {
      await this.db.transaction(async (tx) => {
        await tx.delete(schema.vesselUsers).where(eq(schema.vesselUsers.vesselId, vesselId));
        if (users.length > 0) {
          await tx.insert(schema.vesselUsers).values(
            users.map((u) => ({
              vesselId,
              username: u.username,
              role: u.role,
              active: u.active,
              canSubmit: u.canSubmit,
              updatedAt: u.updatedAt,
              reportedAt: now,
            })),
          );
        }
      });
    }

    if (appliedCommandIds && appliedCommandIds.length > 0) {
      for (const id of appliedCommandIds) {
        await this.db
          .update(schema.userCommands)
          .set({ appliedAt: now })
          .where(and(eq(schema.userCommands.id, id), eq(schema.userCommands.vesselId, vesselId)));
      }
    }

    const pending = await this.db
      .select()
      .from(schema.userCommands)
      .where(and(eq(schema.userCommands.vesselId, vesselId), isNull(schema.userCommands.appliedAt)));

    if (pending.length > 0) {
      for (const cmd of pending) {
        await this.db.update(schema.userCommands).set({ fetchedAt: now }).where(eq(schema.userCommands.id, cmd.id));
      }
    }

    return pending.map(serializeCommand);
  }
}
