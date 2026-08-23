import { Controller, Post, Body, Res, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Response } from 'express';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(@Body() signInDto: Record<string, any>, @Res({ passthrough: true }) res: Response) {
    const user = await this.authService.validateUser(signInDto.username, signInDto.password);
    const { access_token } = await this.authService.login(user);
    
    // Secure defaults off — mirrors the original's own secureCookies
    // (vessel/httpapi/server.go): plain-HTTP standalone/LAN use is this
    // app's common case, and a Secure cookie is silently dropped by the
    // browser over HTTP, breaking login entirely. Opt in via
    // COOKIE_SECURE=true only once an operator puts real TLS in front.
    res.cookie('vessel_auth_token', access_token, {
      httpOnly: true,
      secure: process.env.COOKIE_SECURE === 'true',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 1 day
    });

    return { success: true, mustChangePassword: !!user.mustChangePassword };
  }

  @Post('logout')
  async logout(@Res({ passthrough: true }) res: Response) {
    // Must match the login cookie's attributes to reliably overwrite/
    // clear it — a mismatched Secure/SameSite means some browsers keep
    // the original cookie instead of clearing it.
    res.clearCookie('vessel_auth_token', {
      httpOnly: true,
      secure: process.env.COOKIE_SECURE === 'true',
      sameSite: 'lax',
    });
    return { success: true };
  }
}
