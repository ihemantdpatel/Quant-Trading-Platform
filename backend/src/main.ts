import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { StartupAssertionError } from './risk/startup-assertions';

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

/**
 * A failed startup assertion is a **configuration** error, not a crash.
 *
 * Reported as a single legible message and exited cleanly, because the raw
 * stack trace of an unhandled rejection buries the one line an operator needs
 * under Nest's internals — and compose restarts the container on failure, so
 * that stack is then reprinted every few seconds.
 *
 * The refusal itself is preserved: the process still does not start, which is
 * the entire point of the assertion. Only the reporting changes.
 */
void bootstrap().catch((error: unknown) => {
  if (error instanceof StartupAssertionError) {
    Logger.error(error.message, undefined, 'Bootstrap');
    process.exit(1);
  }

  throw error;
});
