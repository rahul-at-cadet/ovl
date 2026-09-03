import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { TrpcModule } from './rpc/trpc.module';
import { ReportsModule } from './reports/reports.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { SchemaVersionsModule } from './config/schema-versions/schema-versions.module';

@Module({
  imports: [
    AttachmentsModule,
    SchemaVersionsModule,
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
        appName: 'Sparks',
        apiDomain: process.env.API_DOMAIN || 'http://localhost:3001',
        websiteDomain: process.env.WEBSITE_DOMAIN || 'http://localhost:3000',
        // Under the global /api prefix, same as every controller.
        //
        // Not cosmetic: setGlobalPrefix('api') also narrows the Nest
        // middleware this recipe is mounted through (AuthModule applies it
        // with forRoutes('*'), which the prefix rewrites to /api/*), so
        // with apiBasePath left at '/auth' the middleware never ran for
        // /auth/* and did not recognise /api/auth/* either — every auth
        // route 404'd. Must stay identical to the frontend SDK's
        // apiBasePath in web-office/src/components/providers/
        // supertokens-provider.tsx.
        apiBasePath: '/api/auth',
        websiteBasePath: '/login',
      },
    }),
    UsersModule,
    TrpcModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

