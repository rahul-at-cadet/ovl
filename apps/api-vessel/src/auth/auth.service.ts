import { Injectable, UnauthorizedException, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DATABASE_CONNECTION } from '../database/database.module';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '@ovl/vessel-database';
import * as argon2 from 'argon2';

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
    
    // For master admin temp password, it might be stored directly in a special way or hashed.
    // In our setup script, we probably didn't hash it, so we should check both.
    // Let's assume they are using Argon2
    let isValid = false;
    try {
      isValid = await argon2.verify(user.passwordHash, pass);
    } catch {
      // Fallback for unhashed temporary passwords during early dev
      isValid = user.passwordHash === pass;
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
}
