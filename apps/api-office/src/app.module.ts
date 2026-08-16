import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { TrpcModule } from './rpc/trpc.module';
import { ReportsModule } from './reports/reports.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Load root .env first, then app-level .env — root always wins
      // Change DATABASE_URL in the root .env to switch Postgres instances
      envFilePath: [
        '../../.env',          // monorepo root (highest priority)
        '.env',                // app-local fallback
      ],
    }),
    DatabaseModule,
    AuthModule.forRoot({
      connectionURI: process.env.SUPERTOKENS_CONNECTION_URI || 'http://localhost:3567',
      apiKey: process.env.SUPERTOKENS_API_KEY,
      appInfo: {
        appName: 'OVL Office',
        apiDomain: process.env.API_DOMAIN || 'http://localhost:3000',
        websiteDomain: process.env.WEBSITE_DOMAIN || 'http://localhost:5173',
        apiBasePath: '/auth',
        websiteBasePath: '/auth',
      },
    }),
    UsersModule,
    TrpcModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

