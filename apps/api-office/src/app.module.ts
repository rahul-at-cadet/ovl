import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    DatabaseModule,
    AuthModule.forRoot({
      connectionURI: process.env.SUPERTOKENS_CONNECTION_URI || "https://try.supertokens.com",
      appInfo: {
        appName: "OVL Office",
        apiDomain: "http://localhost:3000",
        websiteDomain: "http://localhost:3000",
        apiBasePath: "/auth",
        websiteBasePath: "/auth"
      },
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
