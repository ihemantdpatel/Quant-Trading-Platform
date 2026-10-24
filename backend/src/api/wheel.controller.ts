import { Body, Controller, Get, Post, UnprocessableEntityException } from '@nestjs/common';
import { WheelService } from '../engine/wheel.service';

@Controller('wheel')
export class WheelController {
  constructor(private readonly wheel: WheelService) {}
  @Get() status() {
    return this.call(() => this.wheel.status());
  }
  @Post('configure') configure(@Body() body: unknown) {
    return this.call(() => this.wheel.configure(body));
  }
  @Post('enable') enable() {
    return this.call(() => this.wheel.setEnabled(true));
  }
  @Post('disable') disable() {
    return this.call(() => this.wheel.setEnabled(false));
  }
  @Post('preview') preview() {
    return this.call(() => this.wheel.preview());
  }
  @Post('run') run() {
    return this.call(() => this.wheel.run());
  }
  @Post('clear-halt') clearHalt(@Body() body: { reference?: string }) {
    return this.call(() => this.wheel.clearHalt(body?.reference ?? ''));
  }
  @Post('reconcile') reconcile(@Body() body: { reference?: string }) {
    return this.call(() => this.wheel.reconcile(body?.reference ?? ''));
  }
  private async call<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw new UnprocessableEntityException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
