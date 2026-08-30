import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Error as STError } from 'supertokens-node';
import { verifySession } from 'supertokens-node/recipe/session/framework/express';
import { SupertokensService } from './supertokens.service';
import { PlatformDbService } from '../tenancy/platform-db.service';
import { Inject, Optional } from '@nestjs/common';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly supertokensService: SupertokensService,
    // Optional: only present when multi-tenancy is enabled.
    @Optional() @Inject(PlatformDbService) private readonly platformDb?: PlatformDbService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ctx = context.switchToHttp();
    const req = ctx.getRequest();
    const resp = ctx.getResponse();

    let err: unknown = undefined;

    // Verify the SuperTokens session and attach session to req.session
    await verifySession()(req, resp, (res) => {
      err = res;
    });

    if (resp.headersSent) {
      throw new STError({ message: 'RESPONSE_SENT', type: 'RESPONSE_SENT' });
    }

    if (err) {
      throw err;
    }

    // Attach the full local Postgres user (with roles) to the request
    const stUserId = req.session.getUserId();
    const localUser = await this.supertokensService.getLocalUser(stUserId);

    if (!localUser || !localUser.active) {
      // A platform super admin has no local profile, because a local profile
      // lives inside a tenant schema and they belong to no tenant. Rejecting
      // them here would make the platform operator the one identity that
      // cannot use the application at all — including the tenant management
      // screen that exists for them.
      //
      // They are given a synthetic profile rather than a real one: nothing is
      // written to any tenant, and every tenant-scoped procedure still has to
      // resolve a tenant of its own, which for a super admin means the one
      // they have explicitly selected.
      const superAdmin = await this.asSuperAdmin(stUserId);
      if (superAdmin) {
        req.user = superAdmin;
        return true;
      }
      throw new UnauthorizedException('User not found or deactivated');
    }

    req.user = localUser;
    return true;
  }

  /**
   * A profile for a super admin who has no tenant profile, or null if this
   * identity is not one.
   */
  private async asSuperAdmin(stUserId: string): Promise<Record<string, unknown> | null> {
    if (!this.platformDb) return null;
    if (!(await this.platformDb.isSuperAdmin(stUserId))) return null;

    const stUser = await this.supertokensService.getSupertokensUser(stUserId);
    return {
      id: stUserId,
      username: stUser?.emails?.[0] ?? 'platform-super-admin',
      // Deliberately not 'admin'. A super admin administers the platform, not
      // any tenant's fleet, and borrowing a tenant role here would grant that
      // by accident on every role check in the app.
      roles: ['superAdmin'],
      active: true,
      isPlatformSuperAdmin: true,
    };
  }
}

