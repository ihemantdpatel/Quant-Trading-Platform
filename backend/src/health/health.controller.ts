import { Controller, Get } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { ExecutionMode } from '../config/execution-mode';

export interface HealthResponse {
  status: 'ok';
  mode: ExecutionMode;
}

@Controller('health')
export class HealthController {
  constructor(private readonly config: AppConfigService) {}

  /**
   * Reports execution mode alongside liveness so an operator (and the compose
   * healthcheck) can see at a glance which mode the daemon came up in.
   */
  @Get()
  check(): HealthResponse {
    return {
      status: 'ok',
      mode: this.config.executionMode,
    };
  }
}
