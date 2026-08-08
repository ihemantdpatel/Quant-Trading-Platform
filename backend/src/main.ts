import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(AppConfigService);

  // The dashboard is a separate origin (localhost:3001) calling this daemon
  // directly from the browser. Everything is local, so any origin is fine.
  app.enableCors();

  // Bind to all interfaces so the container's published port is reachable
  // from the host; the default localhost bind is not.
  await app.listen(config.port, '0.0.0.0');

  Logger.log(
    `Trading engine listening on port ${config.port} in ${config.executionMode} mode`,
    'Bootstrap',
  );
}

void bootstrap();
