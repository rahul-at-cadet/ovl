import { Injectable, NotFoundException, BadRequestException, ConflictException, Inject, Optional } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import * as schema from '@ovl/database';
import * as argon2 from 'argon2';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import supertokens from 'supertokens-node';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { AuditService, type AuditActor } from '../audit/audit.service';
import type { LocalUser } from '../auth/supertokens.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserRolesDto } from './dto/update-user.dto';

export type SafeUser = Omit<LocalUser, 'passwordHash'>;

/** Strips the password hash before returning to the client */
function toSafeUser(u: LocalUser): SafeUser {
  const { passwordHash: _pw, ...rest } = u;
  return rest;
}

/** Generates a cryptographically random temporary password */
/**
 * A temporary password that SuperTokens will actually accept.
 *
 * Its default policy requires at least one letter and at least one number.
 * Drawing every character independently from one mixed alphabet does not
 * guarantee either: with this alphabet and 12 characters, a fifth of all draws
 * contained no digit at all, so roughly one in five user creations and
 * password resets failed with PASSWORD_POLICY_VIOLATED_ERROR — intermittently,
 * which is what made it look like an unrelated flake rather than a generator
 * bug.
 *
 * One character is therefore reserved from each required class up front, the
 * rest are drawn freely, and the result is shuffled so the guaranteed
 * characters do not always land in the same positions.
 *
 * Ambiguous glyphs (I, l, O, 0, 1) are excluded throughout, because these are
 * read off a screen and typed by hand.
 */
function randomPassword(length = 12): string {
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$';
  const all = upper + lower + digits + symbols;

  const { randomInt } = require('crypto') as typeof import('crypto');
  const pick = (set: string) => set[randomInt(set.length)];

  const required = [pick(upper), pick(lower), pick(digits)];
  const rest = Array.from({ length: Math.max(0, length - required.length) }, () => pick(all));
  const chars = [...required, ...rest];

  // Fisher-Yates, so the guaranteed upper/lower/digit are not always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

@Injectable()
export class UsersService {
  constructor(
    private readonly tenantDb: TenantDbService,
    // Optional because AuditModule ships with TenancyModule and is registered
    // only when multi-tenancy is on. Without it these methods behave exactly
    // as before and record nothing.
    @Optional() @Inject(AuditService) private readonly audit?: AuditService,
  ) {}

  /**
   * One event about one account, against the tenant the request resolved to.
   *
   * The tenant is not passed in: TenantMiddleware has already put it on the
   * async context and every method here runs inside that context, so an
   * argument for it could only ever disagree with reality.
   */
  private async recordUserEvent(
    event: string,
    actor: AuditActor,
    subject: { id: string; username: string },
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await this.audit?.record({
      event,
      actorUserId: actor.userId ?? null,
      actorEmail: actor.email ?? null,
      actorIsSuperAdmin: actor.isSuperAdmin ?? false,
      subject: subject.username,
      detail: { userId: subject.id, ...detail },
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      requestId: actor.requestId ?? null,
    });
  }

  /** List all users (admin-only). Never returns password hashes. */
  async listUsers(): Promise<SafeUser[]> {
    return this.tenantDb.withTenant(async (db) => {
      const results = await db
        .select()
        .from(schema.users)
        .orderBy(schema.users.createdAt);
      return results.map(toSafeUser);
  }, { readOnly: true });
  }

  /** Get a single user by UUID. */
  async getUser(id: string): Promise<SafeUser> {
    return this.tenantDb.withTenant(async (db) => {
      const results = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, id))
        .limit(1);
      if (!results[0]) throw new NotFoundException(`User ${id} not found`);
      return toSafeUser(results[0]);
  }, { readOnly: true });
  }

  /**
   * Create a new user (admin-initiated).
   * Generates a random temporary password and returns it ONCE — same
   * "reveal once" contract as the Go implementation. The user must change
   * it on first login (mustChangePassword = true).
   *
   * Provisions the real SuperTokens emailpassword identity first — the
   * `users` table alone can't authenticate anyone; the actual login flow
   * (AppShell's session check, AuthGuard) goes entirely through
   * SuperTokens, keyed by email. A user created in only this table would
   * never be able to sign in, which was this function's entire previous
   * behavior. On success, `signUpPOST`'s own override
   * (supertokens.service.ts) would normally auto-insert a `viewer`-role
   * row for a self-service signup, but that path isn't hit for an
   * admin-initiated server-side EmailPassword.signUp call — so the local
   * row here carries the admin's own chosen roles instead of that
   * default, exactly once, right after the identity is created.
   */
  async createUser(
    dto: CreateUserDto,
    actor: AuditActor = {},
  ): Promise<{ user: SafeUser; temporaryPassword: string }> {
    const result = await this.tenantDb.withTenant(async (db) => {
      // Check for duplicate username
      const existing = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.username, dto.username))
        .limit(1);
      if (existing.length > 0) {
        throw new ConflictException(`Username "${dto.username}" already exists`);
      }

      const temporaryPassword = randomPassword(12);

      const signUpResult = await EmailPassword.signUp('public', dto.username, temporaryPassword);
      if (signUpResult.status === 'EMAIL_ALREADY_EXISTS_ERROR') {
        // A SuperTokens identity already exists for this email with no
        // matching local row — most likely an account that predates the
        // signUpPOST auto-provisioning hook. Can't silently adopt it here
        // (we'd be resetting a real, unrelated login's password); the
        // admin needs to know this email is already a login, just not one
        // this app has a profile for.
        throw new ConflictException(
          `An account already exists for "${dto.username}" but has no profile here — this can't be created as a new user.`,
        );
      }

      const passwordHash = await argon2.hash(temporaryPassword, {
        type: argon2.argon2id,
      });

      const now = new Date().toISOString();
      const [created] = await db
        .insert(schema.users)
        .values({
          username: dto.username,
          passwordHash,
          roles: dto.roles as unknown as string,
          mustChangePassword: true,
          createdAt: now,
          updatedAt: now,
          active: true,
        })
        .returning();

      return { user: toSafeUser(created), temporaryPassword };
  });

    // After the transaction, not inside it: the audit write is on its own
    // connection anyway, and a record of a creation that then rolled back
    // would be worse than no record at all.
    await this.recordUserEvent('user.created', actor, result.user, { roles: dto.roles });
    return result;
  }

  /** Update a user's roles (admin-only). */
  async updateUserRoles(
    id: string,
    dto: UpdateUserRolesDto,
    actor: AuditActor = {},
  ): Promise<SafeUser> {
    return this.updateUser(id, { roles: dto.roles }, actor);
  }

  /**
   * Roles and active state in one call, as the tRPC edit dialog sends them.
   *
   * The single implementation both transports go through. The tRPC router
   * used to write this table directly, which meant the REST endpoint recorded
   * an audit event and the screen everyone actually uses recorded nothing —
   * the kind of gap that is invisible until an auditor asks who granted
   * someone admin and the log has no answer.
   */
  async updateUser(
    id: string,
    updates: { roles?: string[]; active?: boolean },
    actor: AuditActor = {},
  ): Promise<SafeUser> {
    const { user, before } = await this.tenantDb.withTenant(async (db) => {
      const existing = await db
        .select({ roles: schema.users.roles, active: schema.users.active })
        .from(schema.users)
        .where(eq(schema.users.id, id))
        .limit(1);
      if (!existing[0]) throw new NotFoundException(`User ${id} not found`);

      const [updated] = await db
        .update(schema.users)
        .set({
          ...(updates.roles ? { roles: updates.roles as unknown as string } : {}),
          ...(updates.active === undefined ? {} : { active: updates.active }),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.users.id, id))
        .returning();
      if (!updated) throw new NotFoundException(`User ${id} not found`);
      return { user: toSafeUser(updated), before: existing[0] };
  });

    // One call can be two events. Recording only the roles change would lose
    // the deactivation; recording one merged event would make "who disabled
    // this account" unanswerable without parsing a diff.
    if (updates.roles && JSON.stringify(updates.roles) !== JSON.stringify(before.roles)) {
      // Both sides of the change: "granted admin" is the entry an auditor
      // looks for, and it cannot be reconstructed from the new roles alone.
      await this.recordUserEvent('user.roles_changed', actor, user, {
        from: before.roles,
        to: updates.roles,
      });
    }
    if (updates.active !== undefined && updates.active !== before.active) {
      await this.recordUserEvent(
        updates.active ? 'user.reactivated' : 'user.deactivated',
        actor,
        user,
      );
    }
    return user;
  }

  /**
   * Removes the local profile.
   *
   * Note that it does not remove the SuperTokens identity, so the person can
   * still authenticate and simply has no profile — the same state AuthGuard
   * rejects. That predates this change and is left alone here; what is new is
   * that the removal is recorded.
   */
  async deleteUser(id: string, actor: AuditActor = {}): Promise<{ success: true }> {
    const user = await this.tenantDb.withTenant(async (db) => {
      const [deleted] = await db
        .delete(schema.users)
        .where(eq(schema.users.id, id))
        .returning();
      if (!deleted) throw new NotFoundException(`User ${id} not found`);
      return toSafeUser(deleted);
  });

    await this.recordUserEvent('user.deleted', actor, user, { roles: user.roles });
    return { success: true };
  }

  /** Deactivate a user — prevents login without deleting the account. */
  async deactivateUser(id: string, actor: AuditActor = {}): Promise<SafeUser> {
    const user = await this.tenantDb.withTenant(async (db) => {
      const [updated] = await db
        .update(schema.users)
        .set({ active: false, updatedAt: new Date().toISOString() })
        .where(eq(schema.users.id, id))
        .returning();
      if (!updated) throw new NotFoundException(`User ${id} not found`);
      return toSafeUser(updated);
  });

    await this.recordUserEvent('user.deactivated', actor, user);
    return user;
  }

  /** Reactivate a previously deactivated user. */
  async reactivateUser(id: string, actor: AuditActor = {}): Promise<SafeUser> {
    const user = await this.tenantDb.withTenant(async (db) => {
      const [updated] = await db
        .update(schema.users)
        .set({ active: true, updatedAt: new Date().toISOString() })
        .where(eq(schema.users.id, id))
        .returning();
      if (!updated) throw new NotFoundException(`User ${id} not found`);
      return toSafeUser(updated);
  });

    await this.recordUserEvent('user.reactivated', actor, user);
    return user;
  }

  /**
   * Admin-initiated password reset — generates and returns a new temporary
   * password. Same "reveal once" contract as createUser.
   *
   * Updates the real SuperTokens password, not just this table's own
   * passwordHash column — resetting only the local copy would generate a
   * "temporary password" the person could never actually sign in with,
   * since login is verified against SuperTokens, not this table.
   */
  async resetUserPassword(
    id: string,
    actor: AuditActor = {},
  ): Promise<{ user: SafeUser; temporaryPassword: string }> {
    const result = await this.tenantDb.withTenant(async (db) => {
      const existing = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
      if (!existing[0]) throw new NotFoundException(`User ${id} not found`);

      const stUsers = await supertokens.listUsersByAccountInfo('public', { email: existing[0].username });
      const recipeUserId = stUsers[0]?.loginMethods[0]?.recipeUserId;
      if (!recipeUserId) {
        throw new NotFoundException(`No SuperTokens login found for "${existing[0].username}" — this user can't sign in and has no password to reset.`);
      }

      const temporaryPassword = randomPassword(12);
      const updateResult = await EmailPassword.updateEmailOrPassword({ recipeUserId, password: temporaryPassword });
      if (updateResult.status !== 'OK') {
        throw new BadRequestException(`Failed to reset password: ${updateResult.status}`);
      }

      const passwordHash = await argon2.hash(temporaryPassword, {
        type: argon2.argon2id,
      });

      const [updated] = await db
        .update(schema.users)
        .set({
          passwordHash,
          mustChangePassword: true,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.users.id, id))
        .returning();

      return { user: toSafeUser(updated), temporaryPassword };
  });

    // The password itself is never recorded, only that one was issued — an
    // audit log that stores credentials is a credential store.
    await this.recordUserEvent('user.password_reset', actor, result.user);
    return result;
  }

  /**
   * Self-service password change — verifies the current password before
   * allowing the update. Sets mustChangePassword = false.
   */
  async changeOwnPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    actor: AuditActor = {},
  ): Promise<SafeUser> {
    const user = await this.tenantDb.withTenant(async (db) => {
      const results = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      const user = results[0];
      if (!user) throw new NotFoundException('User not found');

      const match = await argon2.verify(user.passwordHash, currentPassword);
      if (!match) throw new BadRequestException('Current password is incorrect');

      if (newPassword.length < 8) {
        throw new BadRequestException('New password must be at least 8 characters');
      }

      // Updating only this table's own shadow copy would leave the real
      // SuperTokens credential unchanged — login is verified against
      // SuperTokens, not this column, so the person would be locked out
      // with a "changed" password that never actually works. Same fix
      // already applied to resetUserPassword; this path just never got it.
      const stUsers = await supertokens.listUsersByAccountInfo('public', { email: user.username });
      const recipeUserId = stUsers[0]?.loginMethods[0]?.recipeUserId;
      if (!recipeUserId) {
        throw new NotFoundException(`No SuperTokens login found for "${user.username}" — this user can't sign in and has no password to change.`);
      }
      const updateResult = await EmailPassword.updateEmailOrPassword({ recipeUserId, password: newPassword });
      if (updateResult.status !== 'OK') {
        throw new BadRequestException(`Failed to update password: ${updateResult.status}`);
      }

      const newHash = await argon2.hash(newPassword, { type: argon2.argon2id });
      const [updated] = await db
        .update(schema.users)
        .set({
          passwordHash: newHash,
          mustChangePassword: false,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.users.id, userId))
        .returning();

      return toSafeUser(updated);
  });

    // Classed as an authentication event, not an administrative one: this is
    // someone changing their own credential, which is what the twelve-month
    // auth tier is for.
    await this.recordUserEvent('auth.password_changed', actor, user);
    return user;
  }
}
