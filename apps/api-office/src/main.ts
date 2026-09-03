import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SupertokensExceptionFilter } from './auth/auth.filter';
import supertokens from 'supertokens-node';
import * as trpcExpress from '@trpc/server/adapters/express';
import { TrpcRouter } from './rpc/trpc.router';
import { AppErrorFilter } from './common/app-error.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  const websiteDomain = process.env.WEBSITE_DOMAIN || 'http://localhost:5173';
  const allowedOrigins = [websiteDomain, 'http://localhost:3000', 'http://localhost:5173'];

  app.enableCors({
    origin: [...new Set(allowedOrigins)], // deduplicate
    allowedHeaders: ['content-type', ...supertokens.getAllCORSHeaders()],
    credentials: true,
  });

  const trpc = app.get(TrpcRouter);
  app.use(
    '/trpc',
    trpcExpress.createExpressMiddleware({
      router: trpc.appRouter,
      createContext: require('./rpc/trpc.router').createContext,
    }),
  );

  // Both filters, and the order matters: SuperTokens' own must keep
  // handling its errors, and AppErrorFilter only claims @Catch(AppError).
  app.useGlobalFilters(new SupertokensExceptionFilter(), new AppErrorFilter());

  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
bootstrap();
