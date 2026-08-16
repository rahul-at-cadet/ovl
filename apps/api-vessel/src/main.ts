import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as trpcExpress from '@trpc/server/adapters/express';
import { TrpcRouter } from './rpc/trpc.router';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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
