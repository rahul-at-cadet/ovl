import { Module, MiddlewareConsumer, NestModule, DynamicModule } from '@nestjs/common';
import { SupertokensService, ConfigInjectionToken, AuthModuleConfig } from './supertokens.service';
import { AuthMiddleware } from './auth.middleware';

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
            ],
            exports: [SupertokensService],
        };
    }
}
