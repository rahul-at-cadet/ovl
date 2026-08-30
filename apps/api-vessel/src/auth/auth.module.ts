import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { DATABASE_CONNECTION } from '../database/database.module';
import { resolveJwtSecret } from './jwt-secret';

@Module({
  imports: [
    // Async so the secret can come from this vessel's own config store
    // rather than a constant every vessel shares — see resolveJwtSecret.
    // DatabaseModule is @Global, so the connection injects here without
    // this module importing it.
    JwtModule.registerAsync({
      global: true,
      inject: [DATABASE_CONNECTION],
      useFactory: async (db: any) => ({
        secret: await resolveJwtSecret(db),
        signOptions: { expiresIn: '1d' },
      }),
    }),
  ],
  providers: [AuthService],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
