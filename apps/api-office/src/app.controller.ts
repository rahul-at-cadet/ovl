import { Controller, Get, UseGuards } from '@nestjs/common';
import { AppService } from './app.service';
import { AuthGuard } from './auth/auth.guard';
import { CurrentUser } from './auth/current-user.decorator';
import type { LocalUser } from './auth/supertokens.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * GET /me — returns the currently authenticated user's profile.
   * Protected by SuperTokens session via AuthGuard.
   */
  @Get('me')
  @UseGuards(AuthGuard)
  getMe(@CurrentUser() user: LocalUser) {
    const { passwordHash: _pw, ...safeUser } = user;
    return safeUser;
  }
}

