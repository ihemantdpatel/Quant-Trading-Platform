import { ReplayService } from '../../market-data/mock/replay.service';
import { Bar } from '../../market-data/types';
import { runStrategyContractSuite } from '../contract-test-suite';
import { OrderIntent, StrategyState } from '../types';
import { buildDipLadderConfig } from './config';
import { DipLadderStrategy } from './dip-ladder.strategy';
import { LotStatus } from './lot';
import { replayLadder } from './replay-ladder';
import { RungStatus } from './rung';

const NOW = '2025-01-02T10:00:00.000-05:00';

function ladder(overrides = {}): DipLadderStrategy {
  return new DipLadderStrategy(
    buildDipLadderConfig('TQQQ', { symbolCapital: 100_000, ...overrides }),
  );
}

async function runBars(
  strategy: DipLadderStrategy,
  bars: Bar[],
): Promise<{ state: StrategyState; intents: OrderIntent[] }> {
  const state = await strategy.initialize({
    strategyId: strategy.id,
    symbols: ['TQQQ'],
    now: NOW,
    parameters: {},
    history: [],
  });

  const intents = bars.flatMap((bar) => strategy.onBar(bar, state));

  return { state, intents };
}

/**
 * The dip ladder passes the same shared suite as the three scaffolds
 * (`stories.md:260`). The `chop-range` fixture is used as the bar input so the
 * no-I/O and serializability assertions run against state that has actually
 * cycled, not just initial state.
 */
runStrategyContractSuite({
  name: 'DipLadderStrategy',
  create: () => ladder(),
  symbols: ['TQQQ'],
  bars: new ReplayService().getBars('chop-range').slice(0, 200),
});

describe('DipLadderStrategy', () => {
  const replay = new ReplayService();

  it('derives its id from the symbol so two ladders are distinguishable', () => {
    expect(ladder().id).toBe('dip-ladder:TQQQ');
    expect(new DipLadderStrategy(buildDipLadderConfig('SPY', { symbolCapital: 1000 })).id).toBe(
      'dip-ladder:SPY',
    );
  });

  it('exposes its symbol and parameters for the engine and dashboard', () => {
    const strategy = ladder({ takeProfitPercent: 0.07 });

    expect(strategy.symbol).toBe('TQQQ');
    expect(strategy.parameters.takeProfitPercent).toBe(0.07);
    expect(strategy.parameters.symbolCapital).toBe(100_000);
  });

  it('ignores pre- and post-market bars entirely', async () => {
    // `PRD.md:100` — excluded from firing *and* from session tracking, so an
    // after-hours print never becomes the anchor for the next session.
    const strategy = ladder();
    const bars = replay
      .getBars('session-edges')
      .filter((bar) => bar.timestamp.slice(11, 16) < '09:30');

    const { intents, state } = await runBars(strategy, bars);

    expect(intents).toEqual([]);
    expect((state.data as unknown as { runningClose: number | null }).runningClose).toBeNull();
  });

  it('initializes with an empty, fully serializable ladder', async () => {
    const strategy = ladder();
    const state = await strategy.initialize({
      strategyId: strategy.id,
      symbols: ['TQQQ'],
      now: NOW,
      parameters: {},
      history: [],
    });

    expect(state.data).toEqual({
      lots: [],
      rungs: [],
      firstEntryPrice: null,
      lotSequence: 0,
      previousSessionClose: null,
      runningClose: null,
      sessionOpen: null,
      sessionDate: null,
    });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it('ignores bars for a symbol it does not trade', async () => {
    const strategy = ladder();
    const bars = replay
      .getBars('chop-range')
      .slice(0, 50)
      .map((bar) => ({ ...bar, symbol: 'SPY' }));
    const { intents, state } = await runBars(strategy, bars);

    expect(intents).toEqual([]);
    expect(DipLadderStrategy.lotsOf(state)).toEqual([]);
  });

  it('emits no intents from onTick — firing is decided on bar close', async () => {
    const strategy = ladder();
    const state = await strategy.initialize({
      strategyId: strategy.id,
      symbols: ['TQQQ'],
      now: NOW,
      parameters: {},
      history: [],
    });

    expect(strategy.onTick()).toEqual([]);
    expect(strategy.evaluate()).toEqual([]);
    expect(DipLadderStrategy.lotsOf(state)).toEqual([]);
  });

  /**
   * The headline equivalence: driving the ladder through the `Strategy`
   * interface must produce exactly what the Story 4 harness produced. If these
   * diverge, the adapter changed behaviour — which is the one thing it must
   * not do.
   */
  describe('parity with the Story 4 replay harness', () => {
    const config = buildDipLadderConfig('TQQQ', { symbolCapital: 100_000 });

    it('produces identical entry prices and quantities on chop-range', async () => {
      const bars = replay.getBars('chop-range');
      const harness = replayLadder(bars, config);
      const { intents } = await runBars(new DipLadderStrategy(config), bars);

      const buys = intents.filter((intent) => intent.side === 'BUY');

      expect(buys).toHaveLength(harness.entries.length);
      expect(buys.map((b) => b.limitPrice)).toEqual(harness.entries.map((e) => e.limitPrice));
      expect(buys.map((b) => b.quantity)).toEqual(harness.entries.map((e) => e.quantity));
      expect(buys.map((b) => b.timestamp)).toEqual(harness.entries.map((e) => e.timestamp));
    });

    it('produces identical exits on chop-range', async () => {
      const bars = replay.getBars('chop-range');
      const harness = replayLadder(bars, config);
      const { intents } = await runBars(new DipLadderStrategy(config), bars);

      const sells = intents.filter((intent) => intent.side === 'SELL');

      expect(sells).toHaveLength(harness.exits.length);
      expect(sells.map((s) => s.limitPrice)).toEqual(harness.exits.map((e) => e.limitPrice));

      // Lot ids are deliberately symbol-prefixed here (`TQQQ-lot-1`) where the
      // harness used a bare sequence, so two ladders on two symbols cannot
      // collide. The *disposal order* is what must match, so compare the
      // sequence numbers rather than the raw ids.
      const sequenceOf = (id: string): string => id.replace(/^.*lot-/, '');

      expect(sells.map((s) => sequenceOf(s.metadata!.lotId as string))).toEqual(
        harness.exits.map((e) => sequenceOf(e.lotId)),
      );
    });

    it('reaches the same final lot and rung state on steady-decline', async () => {
      const bars = replay.getBars('steady-decline');
      const harness = replayLadder(bars, config);
      const { state } = await runBars(new DipLadderStrategy(config), bars);

      const lots = DipLadderStrategy.lotsOf(state);
      const rungs = DipLadderStrategy.rungsOf(state);

      expect(lots.map((l) => l.rungPrice)).toEqual(harness.lots.map((l) => l.rungPrice));
      expect(rungs.map((r) => r.price)).toEqual(harness.rungs.map((r) => r.price));
    });
  });

  describe('the chop cycle through the Strategy interface', () => {
    it('cycles a rung repeatedly: fire → target → exit → re-arm → fire', async () => {
      const bars = replay.getBars('chop-range');
      const { state, intents } = await runBars(ladder(), bars);

      const rungs = DipLadderStrategy.rungsOf(state);
      const cycled = rungs.filter((rung) => rung.completedCycles > 0);

      expect(cycled.length).toBeGreaterThan(0);
      expect(Math.max(...rungs.map((r) => r.completedCycles))).toBeGreaterThanOrEqual(3);
      expect(intents.filter((i) => i.side === 'SELL').length).toBeGreaterThanOrEqual(3);
    });

    it('re-arms a rung at its original price, never at the exit price', async () => {
      const bars = replay.getBars('chop-range');
      const { state } = await runBars(ladder(), bars);

      const rungs = DipLadderStrategy.rungsOf(state);
      const reArmed = rungs.filter((rung) => rung.status === RungStatus.RE_ARMED);

      reArmed.forEach((rung) => {
        // Every lot that ever occupied this rung must have been opened at it.
        const lotsHere = DipLadderStrategy.lotsOf(state).filter(
          (lot) => lot.rungPrice === rung.price,
        );
        expect(lotsHere.length).toBeGreaterThan(0);
      });
    });

    it('every closed lot exited in profit — no loss-booking path exists', async () => {
      const bars = replay.getBars('chop-range');
      const { state } = await runBars(ladder(), bars);

      DipLadderStrategy.lotsOf(state)
        .filter((lot) => lot.status === LotStatus.CLOSED)
        .forEach((lot) => {
          expect(lot.exitPrice!).toBeGreaterThan(lot.fillPrice);
        });
    });

    it('never emits a SELL for a lot below its target', async () => {
      const bars = replay.getBars('chop-range');
      const { state, intents } = await runBars(ladder(), bars);

      const lotsById = new Map(DipLadderStrategy.lotsOf(state).map((lot) => [lot.id, lot]));

      intents
        .filter((intent) => intent.side === 'SELL')
        .forEach((intent) => {
          const lot = lotsById.get(intent.metadata!.lotId as string)!;
          expect(intent.limitPrice).toBeGreaterThanOrEqual(lot.exitTarget);
        });
    });
  });

  describe('session and window rules survive the adapter', () => {
    it('emits no intent outside the 09:45–16:00 ET firing window', async () => {
      const bars = replay.getBars('session-edges');
      const { intents } = await runBars(ladder(), bars);

      intents.forEach((intent) => {
        const time = intent.timestamp.slice(11, 16);
        expect(time >= '09:45').toBe(true);
        expect(time < '16:00').toBe(true);
      });
    });

    it('tracks previous session close and session open across a multi-session fixture', async () => {
      const bars = replay.getBars('chop-range');
      const { state } = await runBars(ladder(), bars);
      const data = state.data as unknown as {
        previousSessionClose: number | null;
        sessionOpen: number | null;
        sessionDate: string | null;
      };

      expect(data.previousSessionClose).not.toBeNull();
      expect(data.sessionOpen).not.toBeNull();
      expect(data.sessionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('excludes pre/post-market bars from session tracking entirely', async () => {
      const bars = replay.getBars('session-edges');
      const { state } = await runBars(ladder(), bars);
      const data = state.data as unknown as { runningClose: number | null };

      const regularCloses = bars
        .filter((bar) => {
          const time = bar.timestamp.slice(11, 16);
          return time >= '09:30' && time < '16:00';
        })
        .map((bar) => bar.close);

      // The last close tracked must be a regular-session print, never an
      // after-hours one.
      expect(regularCloses).toContain(data.runningClose);
    });
  });

  describe('state durability', () => {
    it('state survives a JSON round trip after a full chop replay', async () => {
      const { state } = await runBars(ladder(), replay.getBars('chop-range'));

      expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    });

    it('resuming from round-tripped state continues the ladder identically', async () => {
      // The Story 8 recovery property, proven at the strategy layer before a
      // database exists: serialize mid-replay, restore, and finish.
      const bars = replay.getBars('chop-range');
      const split = 400;

      const straight = ladder();
      const straightRun = await runBars(straight, bars);

      const resumed = ladder();
      const first = await runBars(resumed, bars.slice(0, split));
      const restored = JSON.parse(JSON.stringify(first.state)) as StrategyState;
      const secondHalf = bars.slice(split).flatMap((bar) => resumed.onBar(bar, restored));

      expect([...first.intents, ...secondHalf].map((i) => i.limitPrice)).toEqual(
        straightRun.intents.map((i) => i.limitPrice),
      );
      expect(DipLadderStrategy.lotsOf(restored)).toEqual(
        DipLadderStrategy.lotsOf(straightRun.state),
      );
      expect(DipLadderStrategy.rungsOf(restored)).toEqual(
        DipLadderStrategy.rungsOf(straightRun.state),
      );
    });

    it('terminate is idempotent and retains lot composition', async () => {
      const { state } = await runBars(ladder(), replay.getBars('chop-range'));
      const before = DipLadderStrategy.lotsOf(state).length;
      const strategy = ladder();

      await strategy.terminate();
      await strategy.terminate();

      // Lots are not cleared: a terminated ladder still holds real shares, and
      // Story 9 reconciles their sum against the broker's net position.
      expect(DipLadderStrategy.lotsOf(state)).toHaveLength(before);
    });
  });

  describe('intent mapping', () => {
    it('maps entries to BUY limit orders on an equity contract', async () => {
      const { intents } = await runBars(ladder(), replay.getBars('steady-decline'));
      const buy = intents.find((intent) => intent.side === 'BUY')!;

      expect(buy.strategyId).toBe('dip-ladder:TQQQ');
      expect(buy.contract).toEqual({
        symbol: 'TQQQ',
        secType: 'STK',
        exchange: 'SMART',
        currency: 'USD',
        multiplier: 1,
      });
      expect(buy.orderType).toBe('LMT');
      expect(buy.timeInForce).toBe('DAY');
      expect(buy.limitPrice).toBeGreaterThan(0);
      expect(buy.reason).toContain('rung');
    });

    it('carries the lot id on every exit so a fill can be matched to its lot', async () => {
      const { intents } = await runBars(ladder(), replay.getBars('chop-range'));

      intents
        .filter((intent) => intent.side === 'SELL')
        .forEach((intent) => {
          expect(typeof intent.metadata?.lotId).toBe('string');
          expect(typeof intent.metadata?.rungPrice).toBe('number');
        });
    });

    it('sizes every rung from symbol capital, flat by default', async () => {
      const { intents } = await runBars(
        ladder({ symbolCapital: 100_000 }),
        replay.getBars('steady-decline'),
      );
      const buys = intents.filter((intent) => intent.side === 'BUY');

      buys.forEach((buy) => {
        expect(buy.quantity).toBe(Math.floor((100_000 * 0.25) / buy.limitPrice));
      });
    });

    it('emits zero-quantity intents when symbol capital is unset', async () => {
      // The honest answer while `PRD.md:112` stands — SHADOW replay still
      // produces correctly *priced* intents, and Story 5's assertion refuses
      // PAPER/LIVE until a figure is configured.
      const strategy = new DipLadderStrategy(buildDipLadderConfig('TQQQ'));
      const { intents } = await runBars(strategy, replay.getBars('steady-decline'));

      expect(intents.length).toBeGreaterThan(0);
      intents.forEach((intent) => {
        expect(intent.quantity).toBe(0);
        expect(intent.limitPrice).toBeGreaterThan(0);
      });
    });
  });
});

/**
 * The state transitions the engine drives when an order rests at the broker.
 *
 * Static rather than instance methods because the engine holds `StrategyState`,
 * not the strategy object, at the point a fill arrives — the coordinator owns
 * the state and hands the same reference to every hook.
 */
describe('resting-order state transitions', () => {
  const config = buildDipLadderConfig('TQQQ', { symbolCapital: 40_000 });

  async function freshState(): Promise<StrategyState> {
    return new DipLadderStrategy(config).initialize({} as never);
  }

  it('records a working order, creating the rung if it is new', async () => {
    const state = await freshState();

    DipLadderStrategy.recordWorkingOrder(state, 95, 'co-1');

    const [rung] = DipLadderStrategy.rungsOf(state)!;
    expect(rung.price).toBe(95);
    expect(rung.status).toBe(RungStatus.WORKING);
    expect(rung.workingOrderId).toBe('co-1');
  });

  it('marks an existing rung working rather than duplicating the level', async () => {
    // The re-arm path: the rung already exists at its original price, and a new
    // order at that level must reuse it or the ledger accumulates duplicates.
    const state = await freshState();

    DipLadderStrategy.recordWorkingOrder(state, 95, 'co-1');
    DipLadderStrategy.clearWorkingOrder(state, 'co-1');
    DipLadderStrategy.recordWorkingOrder(state, 95, 'co-2');

    const rungs = DipLadderStrategy.rungsOf(state)!;
    expect(rungs).toHaveLength(1);
    expect(rungs[0].workingOrderId).toBe('co-2');
  });

  it('clears a working order by its id and leaves others alone', async () => {
    const state = await freshState();

    DipLadderStrategy.recordWorkingOrder(state, 95, 'co-1');
    DipLadderStrategy.recordWorkingOrder(state, 90.25, 'co-2');
    DipLadderStrategy.clearWorkingOrder(state, 'co-1');

    const rungs = DipLadderStrategy.rungsOf(state)!;
    expect(rungs.find((r) => r.price === 95)!.workingOrderId).toBeNull();
    expect(rungs.find((r) => r.price === 90.25)!.workingOrderId).toBe('co-2');
  });

  it('opens a lot from the actual fill, not the rung price', async () => {
    // A lot's exit target is a percentage of what *that lot actually paid*
    // (`PRD.md:129`), so a fill below the rung must move the target with it.
    const state = await freshState();

    DipLadderStrategy.recordWorkingOrder(state, 95, 'co-1');

    const lot = DipLadderStrategy.openLotFromFill(state, config, {
      rungPrice: 95,
      price: 94.5,
      quantity: 100,
      at: NOW,
    });

    expect(lot.fillPrice).toBe(94.5);
    expect(lot.quantity).toBe(100);
    expect(lot.exitTarget).toBeCloseTo(99.23, 2);

    const [rung] = DipLadderStrategy.rungsOf(state)!;
    expect(rung.status).toBe(RungStatus.HELD);
    expect(rung.lotId).toBe(lot.id);
    expect(rung.workingOrderId).toBeNull();
  });

  it('records the first entry price for the hard floor', async () => {
    const state = await freshState();

    DipLadderStrategy.openLotFromFill(state, config, {
      rungPrice: 95,
      price: 94.5,
      quantity: 100,
      at: NOW,
    });
    DipLadderStrategy.openLotFromFill(state, config, {
      rungPrice: 90.25,
      price: 90,
      quantity: 100,
      at: NOW,
    });

    // The floor is measured from where the ladder *started*, not from the most
    // recent fill.
    expect(DipLadderStrategy.lotsOf(state)).toHaveLength(2);
    expect(state.data.firstEntryPrice).toBe(94.5);
  });

  it('creates the rung when a fill arrives for a level with no record', async () => {
    // The adopted-order path: reconciliation may hand the engine a fill for an
    // order placed by a previous process, whose rung this state never had.
    const state = await freshState();

    const lot = DipLadderStrategy.openLotFromFill(state, config, {
      rungPrice: 88,
      price: 88,
      quantity: 50,
      at: NOW,
    });

    const [rung] = DipLadderStrategy.rungsOf(state)!;
    expect(rung.price).toBe(88);
    expect(rung.lotId).toBe(lot.id);
  });

  it('leaves other rungs untouched when marking one working', async () => {
    // Exercises the non-matching side of the per-rung map: a ledger with
    // several levels must update only the one whose price matches.
    const state = await freshState();

    DipLadderStrategy.recordWorkingOrder(state, 95, 'co-1');
    DipLadderStrategy.clearWorkingOrder(state, 'co-1');
    DipLadderStrategy.recordWorkingOrder(state, 90.25, 'co-2');
    DipLadderStrategy.recordWorkingOrder(state, 95, 'co-3');

    const rungs = DipLadderStrategy.rungsOf(state)!;
    expect(rungs).toHaveLength(2);
    expect(rungs.find((r) => r.price === 95)!.workingOrderId).toBe('co-3');
    expect(rungs.find((r) => r.price === 90.25)!.workingOrderId).toBe('co-2');
  });

  it('marks only the filled rung held when several exist', async () => {
    const state = await freshState();

    DipLadderStrategy.recordWorkingOrder(state, 95, 'co-1');
    DipLadderStrategy.recordWorkingOrder(state, 90.25, 'co-2');

    DipLadderStrategy.openLotFromFill(state, config, {
      rungPrice: 90.25,
      price: 90.25,
      quantity: 100,
      at: NOW,
    });

    const rungs = DipLadderStrategy.rungsOf(state)!;
    expect(rungs.find((r) => r.price === 90.25)!.status).toBe(RungStatus.HELD);
    // The other level still has its order working — a fill at one rung must not
    // disturb another.
    expect(rungs.find((r) => r.price === 95)!.status).toBe(RungStatus.WORKING);
  });

  it('keeps state JSON-serializable after every transition', async () => {
    // `StrategyState` is the durable recovery unit — a Date or Map creeping in
    // here would corrupt recovery rather than fail loudly.
    const state = await freshState();

    DipLadderStrategy.recordWorkingOrder(state, 95, 'co-1');
    DipLadderStrategy.openLotFromFill(state, config, {
      rungPrice: 95,
      price: 94.5,
      quantity: 100,
      at: NOW,
    });

    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});
