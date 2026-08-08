import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BacktestController, MAX_SWEEP_COMBINATIONS } from '../api/backtest.controller';
import { BacktestService, metricRows } from './backtest.service';
import { BarSize } from '../market-data/types';
import {
  InMemoryBacktestRepository,
  InMemoryBarRepository,
} from '../repositories/in-memory/in-memory.repositories';
import { BACKTEST_REPOSITORY, BAR_REPOSITORY } from '../repositories/repository.interfaces';
import { buildDrawdownBars, TQQQ_2020 } from './scenarios/drawdown-fixtures';
import { BacktestRunResult } from './replay-harness';
import { BacktestStatistics } from './statistics';

const FROM = '2020-01-01T00:00:00.000-05:00';
const TO = '2020-12-31T00:00:00.000-05:00';

async function seededService(): Promise<{
  service: BacktestService;
  runs: InMemoryBacktestRepository;
}> {
  const bars = new InMemoryBarRepository();
  await bars.saveAll(buildDrawdownBars(TQQQ_2020));

  const runs = new InMemoryBacktestRepository();

  return { service: new BacktestService(bars, runs), runs };
}

describe('BacktestService', () => {
  it('runs a backtest over a cached range and persists it', async () => {
    const { service, runs } = await seededService();

    const report = await service.run({
      symbol: 'TQQQ',
      barSize: BarSize.DAILY,
      from: FROM,
      to: TO,
    });

    expect(report.barsProcessed).toBeGreaterThan(0);
    expect(await runs.findRun(report.runId)).not.toBeNull();
  }, 60_000);

  it('persists the effective parameter set, not only the overrides', async () => {
    // A result must stay interpretable when the defaults change later.
    const { service, runs } = await seededService();

    const report = await service.run({
      symbol: 'TQQQ',
      barSize: BarSize.DAILY,
      from: FROM,
      to: TO,
      ladder: { spacingPercent: 0.04 },
    });

    const run = await runs.findRun(report.runId);

    expect(run?.parameters).toMatchObject({
      spacingPercent: 0.04,
      // Untouched defaults are stored too.
      maxConcurrentRungs: 5,
      hardFloorPercent: 0.25,
    });
  }, 60_000);

  it('persists metrics for the run', async () => {
    const { service, runs } = await seededService();

    const report = await service.run({
      symbol: 'TQQQ',
      barSize: BarSize.DAILY,
      from: FROM,
      to: TO,
    });
    const results = await runs.findResults(report.runId);

    expect(results.find((r) => r.metric === 'maxDrawdownPercent')).toBeDefined();
    expect(results.find((r) => r.metric === 'completedCycles')).toBeDefined();
    expect(results.find((r) => r.metric === 'barCoverage')).toBeDefined();
  }, 60_000);

  it('is idempotent — the same run upserts rather than accumulating rows', async () => {
    const { service, runs } = await seededService();

    const first = await service.run({ symbol: 'TQQQ', barSize: BarSize.DAILY, from: FROM, to: TO });
    const second = await service.run({
      symbol: 'TQQQ',
      barSize: BarSize.DAILY,
      from: FROM,
      to: TO,
    });

    expect(second.runId).toBe(first.runId);
    expect(await runs.findAllRuns()).toHaveLength(1);
  }, 90_000);

  it('gives different parameter sets different run ids', async () => {
    const { service, runs } = await seededService();

    await service.run({
      symbol: 'TQQQ',
      barSize: BarSize.DAILY,
      from: FROM,
      to: TO,
      ladder: { spacingPercent: 0.04 },
    });
    await service.run({
      symbol: 'TQQQ',
      barSize: BarSize.DAILY,
      from: FROM,
      to: TO,
      ladder: { spacingPercent: 0.06 },
    });

    expect(await runs.findAllRuns()).toHaveLength(2);
  }, 90_000);

  it('throws for a range the cache does not hold', async () => {
    const { service } = await seededService();

    await expect(
      service.run({
        symbol: 'TQQQ',
        barSize: BarSize.DAILY,
        from: '1999-01-01T00:00:00.000-05:00',
        to: '1999-12-31T00:00:00.000-05:00',
      }),
    ).rejects.toThrow('no cached');
  });

  it('persists one run per combination in a sweep', async () => {
    const { service, runs } = await seededService();

    const report = await service.sweep({
      symbol: 'TQQQ',
      barSize: BarSize.DAILY,
      from: FROM,
      to: TO,
      grid: { spacingPercent: [0.04, 0.05, 0.06] },
    });

    expect(report.entries).toHaveLength(3);
    expect(await runs.findAllRuns()).toHaveLength(3);
    expect(new Set(report.entries.map((e) => e.runId)).size).toBe(3);
  }, 120_000);

  it('rejects a sweep with no grid', async () => {
    const { service } = await seededService();

    await expect(
      service.sweep({ symbol: 'TQQQ', barSize: BarSize.DAILY, from: FROM, to: TO }),
    ).rejects.toThrow('requires a grid');
  });

  it('reads a persisted run back with its metrics', async () => {
    const { service } = await seededService();

    const report = await service.run({
      symbol: 'TQQQ',
      barSize: BarSize.DAILY,
      from: FROM,
      to: TO,
    });
    const found = await service.findRun(report.runId);

    expect(found?.run.symbol).toBe('TQQQ');
    expect(found?.results.length).toBeGreaterThan(0);
  }, 60_000);

  it('returns null for an unknown run', async () => {
    const { service } = await seededService();

    expect(await service.findRun('nope')).toBeNull();
  });
});

describe('metricRows', () => {
  const result = {
    barsProcessed: 100,
    coverage: { barCount: 100, largestGapMs: 86_400_000, largestGapAt: '2020-03-01' },
  } as BacktestRunResult;

  function statistics(overrides: Partial<BacktestStatistics> = {}): BacktestStatistics {
    return {
      totalRealizedPnl: 100,
      finalUnrealizedPnl: 0,
      totalCommission: 5,
      totalReturnPercent: 0.01,
      annualizedReturnPercent: 0.02,
      maxDrawdownPercent: 0.3,
      maxDrawdownAt: '2020-03-23',
      maxDrawdownPeak: 100_000,
      maxDrawdownTrough: 70_000,
      completedCycles: 3,
      winningTrades: 3,
      losingTrades: 0,
      winRate: 1,
      averageHoldingPeriodMs: 1000,
      timeInPositionPercent: 0.9,
      timeAtHardFloorPercent: 0.5,
      maxConcurrentLots: 5,
      openLotsAtEnd: 1,
      rungDistribution: { '95.00': 3 },
      ...overrides,
    };
  }

  it('carries drawdown detail alongside its value', () => {
    const rows = metricRows('run-1', statistics(), result);
    const drawdown = rows.find((row) => row.metric === 'maxDrawdownPercent');

    expect(drawdown?.value).toBe(0.3);
    expect(drawdown?.detail).toEqual({
      at: '2020-03-23',
      peak: 100_000,
      trough: 70_000,
    });
  });

  it('stores rung distribution as detail rather than flattening it', () => {
    const rows = metricRows('run-1', statistics(), result);

    expect(rows.find((row) => row.metric === 'rungDistribution')?.detail).toEqual({ '95.00': 3 });
  });

  it('omits a null win rate rather than storing it as zero', () => {
    // Zero and absent mean opposite things: "lost every cycle" versus "closed
    // none". A column that cannot distinguish them misreports the run.
    const rows = metricRows('run-1', statistics({ winRate: null }), result);

    expect(rows.find((row) => row.metric === 'winRate')).toBeUndefined();
  });

  it('omits a null annualized return', () => {
    const rows = metricRows('run-1', statistics({ annualizedReturnPercent: null }), result);

    expect(rows.find((row) => row.metric === 'annualizedReturnPercent')).toBeUndefined();
  });

  it('omits a null holding period', () => {
    const rows = metricRows('run-1', statistics({ averageHoldingPeriodMs: null }), result);

    expect(rows.find((row) => row.metric === 'averageHoldingPeriodMs')).toBeUndefined();
  });

  it('reports bar coverage so a hole in history is persisted with the result', () => {
    const rows = metricRows('run-1', statistics(), result);
    const coverage = rows.find((row) => row.metric === 'barCoverage');

    expect(coverage?.value).toBe(86_400_000);
    expect(coverage?.detail).toMatchObject({ barCount: 100 });
  });

  it('keys every row to the run it belongs to', () => {
    expect(metricRows('run-1', statistics(), result).every((row) => row.runId === 'run-1')).toBe(
      true,
    );
  });
});

describe('backtest HTTP API', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const bars = new InMemoryBarRepository();
    await bars.saveAll(buildDrawdownBars(TQQQ_2020));

    const moduleRef = await Test.createTestingModule({
      controllers: [BacktestController],
      providers: [
        BacktestService,
        { provide: BAR_REPOSITORY, useValue: bars },
        { provide: BACKTEST_REPOSITORY, useValue: new InMemoryBacktestRepository() },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /backtest runs and returns statistics', async () => {
    const response = await request(app.getHttpServer())
      .post('/backtest')
      .send({ symbol: 'TQQQ', barSize: '1day', from: FROM, to: TO })
      .expect(201);

    expect(response.body.runId).toBeDefined();
    expect(response.body.statistics.maxConcurrentLots).toBeGreaterThan(0);
    expect(response.body.coverage).toBeDefined();
  }, 60_000);

  it('GET /backtest lists persisted runs', async () => {
    await request(app.getHttpServer())
      .post('/backtest')
      .send({ symbol: 'TQQQ', barSize: '1day', from: FROM, to: TO })
      .expect(201);

    const response = await request(app.getHttpServer()).get('/backtest').expect(200);

    expect(response.body.count).toBeGreaterThan(0);
  }, 60_000);

  it('GET /backtest/:id returns a run with its metrics', async () => {
    const created = await request(app.getHttpServer())
      .post('/backtest')
      .send({ symbol: 'TQQQ', barSize: '1day', from: FROM, to: TO })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get(`/backtest/${encodeURIComponent(created.body.runId)}`)
      .expect(200);

    expect(response.body.run.symbol).toBe('TQQQ');
    expect(response.body.results.length).toBeGreaterThan(0);
  }, 60_000);

  it('GET /backtest/:id is 404 for an unknown run', async () => {
    await request(app.getHttpServer()).get('/backtest/nope').expect(404);
  });

  it('POST /backtest/sweep runs a grid', async () => {
    const response = await request(app.getHttpServer())
      .post('/backtest/sweep')
      .send({
        symbol: 'TQQQ',
        barSize: '1day',
        from: FROM,
        to: TO,
        grid: { spacingPercent: [0.04, 0.06] },
      })
      .expect(201);

    expect(response.body.entries).toHaveLength(2);
    expect(response.body.entries[0].runId).toBeDefined();
  }, 120_000);

  it('rejects a sweep grid over the combination limit', async () => {
    const response = await request(app.getHttpServer())
      .post('/backtest/sweep')
      .send({
        symbol: 'TQQQ',
        barSize: '1day',
        from: FROM,
        to: TO,
        // 9 × 9 × 9 = 729, well over the limit.
        grid: {
          spacingPercent: Array.from({ length: 9 }, (_, i) => 0.02 + i * 0.01),
          maxConcurrentRungs: Array.from({ length: 9 }, (_, i) => i + 2),
          takeProfitPercent: Array.from({ length: 9 }, (_, i) => 0.02 + i * 0.01),
        },
      })
      .expect(400);

    expect(response.body.message).toContain(String(MAX_SWEEP_COMBINATIONS));
  });

  it('rejects a missing symbol', async () => {
    await request(app.getHttpServer())
      .post('/backtest')
      .send({ barSize: '1day', from: FROM, to: TO })
      .expect(400);
  });

  it('rejects an invalid bar size', async () => {
    await request(app.getHttpServer())
      .post('/backtest')
      .send({ symbol: 'TQQQ', barSize: '17min', from: FROM, to: TO })
      .expect(400);
  });

  it('rejects an inverted range rather than running over zero bars', async () => {
    await request(app.getHttpServer())
      .post('/backtest')
      .send({ symbol: 'TQQQ', barSize: '1day', from: TO, to: FROM })
      .expect(400);
  });

  it('rejects a non-positive symbolCapital', async () => {
    await request(app.getHttpServer())
      .post('/backtest')
      .send({ symbol: 'TQQQ', barSize: '1day', from: FROM, to: TO, symbolCapital: 0 })
      .expect(400);
  });

  it('rejects an unknown ranking', async () => {
    await request(app.getHttpServer())
      .post('/backtest/sweep')
      .send({
        symbol: 'TQQQ',
        barSize: '1day',
        from: FROM,
        to: TO,
        grid: { spacingPercent: [0.05] },
        rankBy: 'VIBES',
      })
      .expect(400);
  });

  it('surfaces an un-backfilled range as a 422 naming the backfill', async () => {
    // Not a 500: the message telling an operator how to fix this is the whole
    // point, and Nest's default handler would replace it with
    // "Internal server error".
    const response = await request(app.getHttpServer())
      .post('/backtest')
      .send({
        symbol: 'TQQQ',
        barSize: '1day',
        from: '1999-01-01T00:00:00.000-05:00',
        to: '1999-12-31T00:00:00.000-05:00',
      })
      .expect(422);

    expect(response.body.message).toContain('no cached');
    expect(response.body.message).toMatch(/backfill/i);
  });

  it('surfaces an un-backfilled range on the sweep endpoint too', async () => {
    const response = await request(app.getHttpServer())
      .post('/backtest/sweep')
      .send({
        symbol: 'TQQQ',
        barSize: '1day',
        from: '1999-01-01T00:00:00.000-05:00',
        to: '1999-12-31T00:00:00.000-05:00',
        grid: { spacingPercent: [0.05] },
      })
      .expect(422);

    expect(response.body.message).toContain('no cached');
  });
});
