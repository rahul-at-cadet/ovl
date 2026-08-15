import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Error as STError } from 'supertokens-node';
import { verifySession } from 'supertokens-node/recipe/session/framework/express';
import { SupertokensService } from './supertokens.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly supertokensService: SupertokensService) {}

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
      throw new UnauthorizedException('User not found or deactivated');
    }

    req.user = localUser;
    return true;
  }
}

