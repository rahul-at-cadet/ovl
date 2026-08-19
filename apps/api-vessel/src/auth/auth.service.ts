import { Injectable, UnauthorizedException, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DATABASE_CONNECTION } from '../database/database.module';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '@ovl/vessel-database';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { TRPCError } from '@trpc/server';


@Injectable()
export class AuthService {
  constructor(
    private jwtService: JwtService,
    @Inject(DATABASE_CONNECTION) private db: BetterSQLite3Database<typeof schema>,
  ) {}

  async validateUser(username: string, pass: string): Promise<any> {
    const users = await this.db.select().from(schema.users).where(eq(schema.users.username, username));
    const user = users[0];
    if (!user) {
      throw new UnauthorizedException();
    }
    // A deactivated account (local or via a remote setActive command, see
    // applyUserCommand below) must actually be blocked from logging in —
    // this check was previously missing entirely, so deactivation had no
    // real effect: correct credentials still logged a deactivated user in.
    if (!user.active) {
      throw new UnauthorizedException();
    }

    let isValid = false;
    try {
      isValid = await argon2.verify(user.passwordHash, pass);
    } catch {
      isValid = false;
    }

    if (isValid) {
      const { passwordHash, ...result } = user;
      return result;
    }
    throw new UnauthorizedException();
  }

  async login(user: any) {
    const payload = { 
      username: user.username, 
      sub: user.id, 
      role: user.role,
      mustChangePassword: user.mustChangePassword 
    };
    return {
      access_token: this.jwtService.sign(payload),
    };
  }

  async changePassword(userId: string, newPasswordHash: string) {
    await this.db.update(schema.users)
      .set({
        passwordHash: newPasswordHash,
        mustChangePassword: false,
        updatedAt: new Date().toISOString()
      })
      .where(eq(schema.users.id, userId));
  }

  /**
   * Creates a user locally from a username/role/temporaryPassword triple —
   * the shared core both the authenticated users.create mutation and
   * applyUserCommand (below, for remotely office-queued commands) call,
   * mirroring the original's createLocalUser (ovl/vessel/httpapi/users.go)
   * so both entry points enforce the same rules in exactly one place.
   */
  async createLocalUser(username: string, role: string, temporaryPassword: string, canSubmit = false) {
    if (role.toLowerCase() === 'master') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'The Master account is created during vessel setup, not created afterward.' });
    }
    const existing = await this.db.select().from(schema.users).where(eq(schema.users.username, username)).limit(1);
    if (existing.length > 0) {
      throw new TRPCError({ code: 'CONFLICT', message: 'That username is already taken.' });
    }
    const passwordHash = await argon2.hash(temporaryPassword);
    const id = crypto.randomUUID();
    await this.db.insert(schema.users).values({
      id,
      username,
      passwordHash,
      role,
      canSubmit,
      mustChangePassword: true,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return id;
  }

  /**
   * Applies one office-queued UserCommand locally (architecture 9.3/12.4's
   * remote user administration, apply half — ported from
   * ovl/vessel/httpapi/usercommands.go's applyUserCommand). Every action
   * reuses exactly the same guardrails as the local, authenticated paths —
   * a remote command is never trusted to do anything a Master couldn't
   * already do sitting at the vessel console. role=master is refused for
   * both create and setRole regardless of what office sent: office already
   * refuses these at queue time too, but the vessel is the final authority
   * over its own accounts and re-checks independently.
   */
  async applyUserCommand(cmd: { action: string; username: string; role: string; temporaryPassword: string; canSubmit: boolean; active: boolean }) {
    switch (cmd.action) {
      case 'create':
        await this.createLocalUser(cmd.username, cmd.role, cmd.temporaryPassword);
        return;
      case 'resetPassword': {
        const rows = await this.db.select().from(schema.users).where(eq(schema.users.username, cmd.username)).limit(1);
        const user = rows[0];
        if (!user) throw new Error(`reset password for ${cmd.username}: user not found`);
        const passwordHash = await argon2.hash(cmd.temporaryPassword);
        await this.db.update(schema.users)
          .set({ passwordHash, mustChangePassword: true, updatedAt: new Date().toISOString() })
          .where(eq(schema.users.id, user.id));
        return;
      }
      case 'setRole': {
        if (cmd.role.toLowerCase() === 'master') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot remotely grant the Master role.' });
        }
        await this.db.update(schema.users)
          .set({ role: cmd.role, updatedAt: new Date().toISOString() })
          .where(eq(schema.users.username, cmd.username));
        return;
      }
      case 'setActive': {
        const rows = await this.db.select().from(schema.users).where(eq(schema.users.username, cmd.username)).limit(1);
        const user = rows[0];
        if (!user) throw new Error(`set active for ${cmd.username}: user not found`);
        if (!cmd.active && user.role.toLowerCase() === 'master') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'The Master account cannot be deactivated.' });
        }
        await this.db.update(schema.users)
          .set({ active: cmd.active, updatedAt: new Date().toISOString() })
          .where(eq(schema.users.id, user.id));
        return;
      }
      case 'setCanSubmit':
        await this.db.update(schema.users)
          .set({ canSubmit: cmd.canSubmit, updatedAt: new Date().toISOString() })
          .where(eq(schema.users.username, cmd.username));
        return;
      default:
        throw new Error(`unknown user command action "${cmd.action}"`);
    }
  }

  /**
   * This vessel's full current user roster, reported on every sync
   * check-in — office's only visibility into who exists on a vessel (see
   * VesselUsersService.handleCheckIn on the office side). No password
   * data.
   */
  async listRosterSummary() {
    const users = await this.db.select().from(schema.users);
    return users.map((u) => ({
      username: u.username,
      role: u.role,
      active: u.active,
      canSubmit: u.canSubmit,
      updatedAt: u.updatedAt,
    }));
  }
}
