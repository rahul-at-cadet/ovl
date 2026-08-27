import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SupertokensExceptionFilter } from './auth/auth.filter';
import supertokens from 'supertokens-node';
import * as trpcExpress from '@trpc/server/adapters/express';
import { TrpcRouter } from './rpc/trpc.router';
import { TenantMiddleware } from './tenancy/tenant.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  const websiteDomain = process.env.WEBSITE_DOMAIN || 'http://localhost:5173';
  const allowedOrigins = [websiteDomain, 'http://localhost:3000', 'http://localhost:5173'];

  app.enableCors({
    origin: [...new Set(allowedOrigins)], // deduplicate
    allowedHeaders: ['content-type', ...supertokens.getAllCORSHeaders()],
    credentials: true,
  });

  // The tRPC handler is mounted with a bare app.use(), which sits outside
  // Nest's middleware chain — so the tenant middleware configured in
  // TenancyModule never runs for /trpc traffic. Mounting it explicitly here,
  // ahead of the handler, is what puts tRPC procedures on the same
  // AsyncLocalStorage context that REST handlers get. Without it every tRPC
  // call would find no tenant and fail closed.
  if (process.env.MULTI_TENANCY_ENABLED === 'true') {
    const tenantMiddleware = app.get(TenantMiddleware);
    app.use('/trpc', (req: any, res: any, next: any) => tenantMiddleware.use(req, res, next));
  }

  const trpc = app.get(TrpcRouter);
  app.use(
    '/trpc',
    trpcExpress.createExpressMiddleware({
      router: trpc.appRouter,
      createContext: require('./rpc/trpc.router').createContext,
    }),
  );

  app.useGlobalFilters(new SupertokensExceptionFilter());

  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
bootstrap();
