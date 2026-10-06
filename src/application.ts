import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import type { Request, Response, NextFunction } from 'express';
import { businessWritesAllowed } from './updater/maintenance';

export async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  app.enableShutdownHooks();
  // Direct backend clients must also respect the persistent maintenance fence.
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (
      !businessWritesAllowed() &&
      request.path !== '/api/system-update/health'
    ) {
      response.status(503).setHeader('Retry-After', '5');
      response.json({
        code: 'SYSTEM_MAINTENANCE',
        message: 'System update maintenance is in progress.',
      });
      return;
    }
    next();
  });

  // Configure cookie parsing middleware
  app.use(cookieParser());

  // Set global route prefix
  app.setGlobalPrefix('api');

  // Enable CORS
  app.enableCors({
    origin: true,
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`Application is running on: http://localhost:${port}/api`);
}
