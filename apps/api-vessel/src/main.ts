import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as trpcExpress from '@trpc/server/adapters/express';
import { TrpcRouter } from './rpc/trpc.router';
import { AppErrorFilter } from './common/app-error.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Every REST controller under /api, for the same reason api-office
  // does it: /reports is both a Next.js page in web-vessel and a
  // controller here, so a single-origin deployment cannot route the two
  // apart by prefix without one. /trpc stays put — it is middleware, not
  // a controller, so setGlobalPrefix does not move it.
  app.setGlobalPrefix('api');

  // Expresses domain errors over HTTP for the REST controllers; the tRPC
  // half is rpc/domain-error.middleware.ts. See common/app-error.ts.
  app.useGlobalFilters(new AppErrorFilter());

  app.enableCors({
    origin: ['http://localhost:3002'],
    credentials: true,
  });

  const trpc = app.get(TrpcRouter);
  
  const cookieParser = require('cookie-parser');
  app.use(cookieParser());

  app.use(
    '/trpc',
    trpcExpress.createExpressMiddleware({
      router: trpc.appRouter,
      createContext: ({ req, res }) => ({ req, res }),
    }),
  );

  await app.listen(process.env.PORT ?? 3003, '0.0.0.0');
}
bootstrap();
