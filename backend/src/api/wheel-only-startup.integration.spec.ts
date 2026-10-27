import { Test } from '@nestjs/testing';

describe('Wheel-only startup preference', () => {
  it('boots with GRID disabled when explicitly requested', async () => {
    const previous = process.env.GRID_ENABLED;
    process.env.GRID_ENABLED = 'false';
    try {
      await jest.isolateModulesAsync(async () => {
        const { AppModule } = await import('../app.module');
        const { CoordinatorService } = await import('../strategies/coordinator.service');
        const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
        const app = module.createNestApplication();
        try {
          await app.init();
          const strategies = app.get(CoordinatorService).snapshots();
          const grid = strategies.find((s) => s.id.startsWith('grid'));
          expect(grid).toBeDefined();
          expect(grid!.enabled).toBe(false);
          expect(strategies.some((s) => s.id.startsWith('dip-ladder'))).toBe(false);
        } finally {
          await app.close();
        }
      });
    } finally {
      if (previous === undefined) delete process.env.GRID_ENABLED;
      else process.env.GRID_ENABLED = previous;
    }
  });
});
