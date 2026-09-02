import { Injectable, Inject, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '@ovl/database';
import * as argon2 from 'argon2';
import { hashPassword, verifyPassword, validatePassword } from '../auth/password';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import supertokens from 'supertokens-node';
import { DATABASE_CONNECTION } from '../database/database.module';
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
function randomPassword(length = 12): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
  const bytes = require('crypto').randomBytes(length);
  return Array.from(bytes as Buffer)
    .map((b: number) => chars[b % chars.length])
    .join('');
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /** List all users (admin-only). Never returns password hashes. */
  async listUsers(): Promise<SafeUser[]> {
    const results = await this.db
      .select()
      .from(schema.users)
      .orderBy(schema.users.createdAt);
    return results.map(toSafeUser);
  }

  /** Get a single user by UUID. */
  async getUser(id: string): Promise<SafeUser> {
    const results = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .limit(1);
    if (!results[0]) throw new NotFoundException(`User ${id} not found`);
    return toSafeUser(results[0]);
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
  ): Promise<{ user: SafeUser; temporaryPassword: string }> {
    // Check for duplicate username
    const existing = await this.db
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

    const passwordHash = await hashPassword(temporaryPassword);

    const now = new Date().toISOString();
    const [created] = await this.db
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
  }

  /** Update a user's roles (admin-only). */
  async updateUserRoles(id: string, dto: UpdateUserRolesDto): Promise<SafeUser> {
    const [updated] = await this.db
      .update(schema.users)
      .set({ roles: dto.roles as unknown as string, updatedAt: new Date().toISOString() })
      .where(eq(schema.users.id, id))
      .returning();
    if (!updated) throw new NotFoundException(`User ${id} not found`);
    return toSafeUser(updated);
  }

  /** Deactivate a user — prevents login without deleting the account. */
  async deactivateUser(id: string): Promise<SafeUser> {
    const [updated] = await this.db
      .update(schema.users)
      .set({ active: false, updatedAt: new Date().toISOString() })
      .where(eq(schema.users.id, id))
      .returning();
    if (!updated) throw new NotFoundException(`User ${id} not found`);
    return toSafeUser(updated);
  }

  /** Reactivate a previously deactivated user. */
  async reactivateUser(id: string): Promise<SafeUser> {
    const [updated] = await this.db
      .update(schema.users)
      .set({ active: true, updatedAt: new Date().toISOString() })
      .where(eq(schema.users.id, id))
      .returning();
    if (!updated) throw new NotFoundException(`User ${id} not found`);
    return toSafeUser(updated);
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
  ): Promise<{ user: SafeUser; temporaryPassword: string }> {
    const existing = await this.db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
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

    const passwordHash = await hashPassword(temporaryPassword);

    const [updated] = await this.db
      .update(schema.users)
      .set({
        passwordHash,
        mustChangePassword: true,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.users.id, id))
      .returning();

    return { user: toSafeUser(updated), temporaryPassword };
  }

  /**
   * Self-service password change — verifies the current password before
   * allowing the update. Sets mustChangePassword = false.
   */
  async changeOwnPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<SafeUser> {
    const results = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const user = results[0];
    if (!user) throw new NotFoundException('User not found');

    const match = await verifyPassword(user.passwordHash, currentPassword);
    if (!match) throw new BadRequestException('Current password is incorrect');

    // Both bounds, not just the floor: argon2's cost scales with input
    // length, so an unbounded field lets an authenticated caller make
    // the server do arbitrary work.
    const invalid = validatePassword(newPassword);
    if (invalid) {
      throw new BadRequestException(invalid);
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

    const newHash = await hashPassword(newPassword);
    const [updated] = await this.db
      .update(schema.users)
      .set({
        passwordHash: newHash,
        mustChangePassword: false,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.users.id, userId))
      .returning();

    return toSafeUser(updated);
  }
}
