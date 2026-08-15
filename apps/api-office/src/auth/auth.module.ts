import { Module, MiddlewareConsumer, NestModule, DynamicModule, Global } from '@nestjs/common';
import { SupertokensService, ConfigInjectionToken, AuthModuleConfig } from './supertokens.service';
import { AuthMiddleware } from './auth.middleware';
import { AuthGuard } from './auth.guard';

/**
 * @Global() makes SupertokensService and AuthGuard available to all modules
 * without needing to re-import AuthModule everywhere.
 */
@Global()
@Module({})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes('*');
  }

  static forRoot(config: AuthModuleConfig): DynamicModule {
    return {
      module: AuthModule,
      providers: [
        {
          useValue: config,
          provide: ConfigInjectionToken,
        },
        SupertokensService,
        AuthGuard,
      ],
      exports: [SupertokensService, AuthGuard],
    };
  }
}
