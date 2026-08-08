import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import { validateConfig } from './config.schema';

/**
 * Global so every later module (risk, strategies, broker) can read execution
 * mode without re-importing. `validate` runs before the app boots, so an
 * invalid EXECUTION_MODE fails startup rather than surfacing mid-session.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      validate: validateConfig,
      // Compose and CI supply env directly. Reading a developer's local .env
      // during tests would make results depend on an untracked file.
      ignoreEnvFile: process.env.NODE_ENV === 'test',
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
