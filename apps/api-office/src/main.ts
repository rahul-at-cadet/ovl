import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SupertokensExceptionFilter } from './auth/auth.filter';
import supertokens from 'supertokens-node';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  const websiteDomain = process.env.WEBSITE_DOMAIN || 'http://localhost:5173';
  const allowedOrigins = [websiteDomain, 'http://localhost:3000', 'http://localhost:5173'];

  app.enableCors({
    origin: [...new Set(allowedOrigins)], // deduplicate
    allowedHeaders: ['content-type', ...supertokens.getAllCORSHeaders()],
    credentials: true,
  });


  app.useGlobalFilters(new SupertokensExceptionFilter());

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
