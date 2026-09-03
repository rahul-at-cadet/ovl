import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SupertokensExceptionFilter } from './auth/auth.filter';
import supertokens from 'supertokens-node';
import * as trpcExpress from '@trpc/server/adapters/express';
import { TrpcRouter } from './rpc/trpc.router';
import { AppErrorFilter } from './common/app-error.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  /**
   * Every REST controller lives under /api.
   *
   * This app and web-office are served on one public origin with a
   * reverse proxy routing by path, and without a prefix the two collide
   * head-on: /users, /reports and /attachments are each simultaneously a
   * Next.js page and a controller here. That is not something prefix
   * routing can express, so the proxy had to name individual endpoints —
   * and it named `/users/me` but not `/users/me/password`, which then
   * returned the Next 404 page to a PATCH request. Every REST endpoint
   * added since has been one nobody remembered to route.
   *
   * With one prefix the proxy needs two stable rules that never grow
   * (see deploy/nginx/nginx.conf, now in this repo rather than hand-kept
   * on the host), and a new controller cannot be unreachable.
   *
   * /trpc is deliberately untouched: it is mounted as middleware rather
   * than a controller, so setGlobalPrefix does not move it. SuperTokens
   * is the opposite case and worth knowing about — it is mounted through
   * a Nest middleware whose forRoutes('*') this prefix rewrites to
   * /api/*, so its apiBasePath had to move to '/api/auth' (app.module.ts)
   * on both sides or every auth route 404s.
   */
  app.setGlobalPrefix('api');

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
