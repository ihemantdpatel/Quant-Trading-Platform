import { DateTime } from 'luxon';
import { BrokerPosition, Fill } from '../broker/broker-adapter.interface';
import { CommissionCorrection } from '../broker/ib/ib-socket';
import { AppConfigService } from '../config/app-config.service';
import { ET_ZONE } from '../market-data/types';
import {
  InMemoryFillRepository,
  InMemoryPositionSnapshotRepository,
} from '../repositories/in-memory/in-memory.repositories';
import {
  COMMISSION_RETRY_MS,
  CommissionRecorderService,
  nextSnapshotRun,
  PositionReader,
  PositionSnapshotService,
  SNAPSHOT_TICK_MS,
  snapshotRows,
} from './position-snapshot.service';

const et = (iso: string): DateTime => DateTime.fromISO(iso, { zone: ET_ZONE });

class FakeReader implements PositionReader {
  connected = true;
  positions: BrokerPosition[] | Error = [];
  private connectedHandlers: Array<() => void> = [];
  private commissionHandlers: Array<(report: CommissionCorrection) => void> = [];

  isConnected(): boolean {
    return this.connected;
  }

  async getPositions(): Promise<BrokerPosition[]> {
    if (this.positions instanceof Error) {
      throw this.positions;
    }
    return this.positions;
  }

  onConnected(handler: () => void): () => void {
    this.connectedHandlers.push(handler);
    return () => (this.connectedHandlers = this.connectedHandlers.filter((h) => h !== handler));
  }

  onCommission(handler: (report: CommissionCorrection) => void): () => void {
    this.commissionHandlers.push(handler);
    return () => (this.commissionHandlers = this.commissionHandlers.filter((h) => h !== handler));
  }

  emitConnected(): void {
    this.connectedHandlers.forEach((h) => h());
  }

  emitCommission(report: CommissionCorrection): void {
    this.commissionHandlers.forEach((h) => h(report));
  }
}

function fill(fillId: string, symbol = 'TQQQ'): Fill {
  return {
    clientOrderId: `co-${fillId}`,
    brokerOrderId: '1',
    fillId,
    symbol,
    side: 'BUY',
    quantity: 100,
    price: 80,
    commission: 0,
    timestamp: '2026-10-05T10:00:00.000-04:00',
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function setup(usesIbBroker = true) {
  const reader = new FakeReader();
  const snapshots = new InMemoryPositionSnapshotRepository();
  const fills = new InMemoryFillRepository();
  const config = { usesIbBroker } as AppConfigService;
  const service = new PositionSnapshotService(reader, snapshots, fills, config, ['TQQQ']);
  return { reader, snapshots, fills, service };
}

describe('snapshotRows', () => {
  it('writes IB’s positions and a zero row for every other known symbol', () => {
    expect(
      snapshotRows('t', [{ symbol: 'TQQQ', quantity: 100, averageCost: 79.5 }], ['SQQQ', 'TQQQ']),
    ).toEqual([
      { takenAt: 't', symbol: 'SQQQ', quantity: 0, averageCost: 0 },
      { takenAt: 't', symbol: 'TQQQ', quantity: 100, averageCost: 79.5 },
    ]);
  });
});

describe('nextSnapshotRun', () => {
  it('runs at 16:20 ET on weekdays, skipping the weekend', () => {
    expect(nextSnapshotRun(et('2026-10-05T12:00')).toISO()).toBe('2026-10-05T16:20:00.000-04:00');
    expect(nextSnapshotRun(et('2026-10-09T16:20')).toISO()).toBe('2026-10-12T16:20:00.000-04:00');
  });
});

describe('PositionSnapshotService', () => {
  afterEach(() => jest.useRealTimers());

  it('records IB’s quantity and average, including the always-tracked symbol when flat', async () => {
    const { reader, snapshots, fills, service } = setup();
    reader.positions = [{ symbol: 'TQQQ', quantity: 192, averageCost: 79.123 }];
    await fills.save(fill('f1', 'SQQQ'));

    const rows = await service.takeSnapshot();

    expect(rows?.map((r) => [r.symbol, r.quantity, r.averageCost])).toEqual([
      ['SQQQ', 0, 0],
      ['TQQQ', 192, 79.123],
    ]);
    expect(await snapshots.findAll()).toHaveLength(2);
  });

  it('starts tracking a flat account with a zero row', async () => {
    const { snapshots, service } = setup();

    await service.takeSnapshot();

    expect((await snapshots.findAll()).map((r) => [r.symbol, r.quantity])).toEqual([['TQQQ', 0]]);
  });

  // "Could not ask" must never be written as "flat" — a zero row would
  // re-anchor the average of a real position to nothing.
  it('writes nothing when the broker is disconnected or the read fails', async () => {
    const { reader, snapshots, service } = setup();

    reader.connected = false;
    expect(await service.takeSnapshot()).toBeNull();

    reader.connected = true;
    reader.positions = new Error('IB did not respond within 10000ms');
    expect(await service.takeSnapshot()).toBeNull();

    expect(await snapshots.findAll()).toEqual([]);
  });

  it('does not start under the mock broker', () => {
    const { reader, service } = setup(false);
    const spy = jest.spyOn(reader, 'onConnected');

    service.onApplicationBootstrap();

    expect(spy).not.toHaveBeenCalled();
  });

  it('snapshots at start when already connected, on every connect, and at 16:20 ET', async () => {
    jest.useFakeTimers();
    const { reader, snapshots, service } = setup();
    let now = et('2026-10-05T16:19');
    service.start(() => now);
    await flush();
    expect(await snapshots.findAll()).toHaveLength(1);

    reader.emitConnected();
    await flush();
    expect(await snapshots.findAll()).toHaveLength(2);

    now = et('2026-10-05T16:20');
    jest.advanceTimersByTime(SNAPSHOT_TICK_MS);
    await flush();
    expect(await snapshots.findAll()).toHaveLength(3);

    // Re-armed for the next weekday, not re-fired every tick.
    jest.advanceTimersByTime(SNAPSHOT_TICK_MS);
    await flush();
    expect(await snapshots.findAll()).toHaveLength(3);

    service.onModuleDestroy();
    reader.emitConnected();
    await flush();
    expect(await snapshots.findAll()).toHaveLength(3);
  });
});

describe('CommissionRecorderService', () => {
  afterEach(() => jest.useRealTimers());

  function recorder() {
    const reader = new FakeReader();
    const fills = new InMemoryFillRepository();
    const service = new CommissionRecorderService(reader, fills);
    service.onApplicationBootstrap();
    return { reader, fills, service };
  }

  it('writes a reported commission onto its fill', async () => {
    const { reader, fills } = recorder();
    await fills.save(fill('f1'));

    reader.emitCommission({ fillId: 'f1', commission: 1.0125 });
    await flush();

    expect((await fills.findByFillId('f1'))?.commission).toBe(1.0125);
  });

  it('retries a commission that beats its fill to the database', async () => {
    jest.useFakeTimers();
    const { reader, fills } = recorder();

    reader.emitCommission({ fillId: 'f1', commission: 1 });
    await flush();
    await fills.save(fill('f1'));
    jest.advanceTimersByTime(COMMISSION_RETRY_MS[0]);
    await flush();

    expect((await fills.findByFillId('f1'))?.commission).toBe(1);
  });

  it('gives up after its retries, creating nothing', async () => {
    jest.useFakeTimers();
    const { reader, fills } = recorder();
    const spy = jest.spyOn(fills, 'updateCommission');

    reader.emitCommission({ fillId: 'never', commission: 1 });
    for (const delay of COMMISSION_RETRY_MS) {
      await flush();
      jest.advanceTimersByTime(delay);
    }
    await flush();
    jest.advanceTimersByTime(10 * 60_000);
    await flush();

    expect(spy).toHaveBeenCalledTimes(COMMISSION_RETRY_MS.length + 1);
    expect(await fills.findAll()).toEqual([]);
  });

  it('ignores IB’s "unknown" sentinel and reports with no execution id', async () => {
    const { reader, fills } = recorder();
    await fills.save(fill('f1'));
    const spy = jest.spyOn(fills, 'updateCommission');

    reader.emitCommission({ fillId: 'f1', commission: Number.MAX_VALUE });
    reader.emitCommission({ fillId: '', commission: 1 });
    await flush();

    expect(spy).not.toHaveBeenCalled();
    expect((await fills.findByFillId('f1'))?.commission).toBe(0);
  });

  it('survives a failed write and stops listening on destroy', async () => {
    jest.useFakeTimers();
    const { reader, fills, service } = recorder();
    jest.spyOn(fills, 'updateCommission').mockRejectedValue(new Error('db down'));

    reader.emitCommission({ fillId: 'f1', commission: 1 });
    await flush();
    service.onModuleDestroy();
    jest.advanceTimersByTime(10 * 60_000);
    await flush();

    expect(fills.updateCommission).toHaveBeenCalledTimes(1);
  });
});
