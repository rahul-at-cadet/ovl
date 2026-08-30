import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@ovl/vessel-database';
import { DATABASE_CONNECTION } from '../database/database.module';

/**
 * Real JWT + live-active-flag check for this app's handful of REST (non-
 * tRPC) endpoints — attachment upload, backup download. Both previously
 * only checked that a 'vessel_auth_token' cookie was PRESENT ("mock auth
 * check"), never that it was a valid, unexpired token for a still-active
 * account. Mirrors trpc.router.ts's own isAuthed middleware so both entry
 * points enforce the same rule.
 */
@Injectable()
export class VesselAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    @Inject(DATABASE_CONNECTION) private readonly db: BetterSQLite3Database<typeof schema>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const token = req.cookies?.['vessel_auth_token'];
    if (!token) throw new UnauthorizedException('Not logged in');

    let decoded: any;
    try {
      decoded = this.jwtService.verify(token);
    } catch {
      throw new UnauthorizedException('Invalid token');
    }

    const rows = await this.db.select().from(schema.users).where(eq(schema.users.id, decoded.sub)).limit(1);
    const user = rows[0];
    // See the matching check in trpc.router.ts's isAuthed: a token for a
    // user this vessel does not have is a different failure from a
    // deactivated account, and saying so saves a pointless hunt through
    // the user list.
    if (!user) {
      throw new UnauthorizedException('Session belongs to a different vessel');
    }
    if (!user.active) {
      throw new UnauthorizedException('Account is inactive');
    }

    req.user = { username: user.username, sub: user.id, role: user.role, canSubmit: user.canSubmit, active: user.active };
    return true;
  }
}
