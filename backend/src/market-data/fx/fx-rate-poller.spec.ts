import { Logger } from '@nestjs/common';
import { FxQuoteReading } from '../../broker/broker-adapter.interface';
import { MockBrokerAdapter } from '../../broker/mock/mock-broker.adapter';
import { FX_MAX_AGE_MS, FxRateBook, FxStatus } from '../../risk/fx-rate';
import { FxQuoteSource, FxRatePoller } from './fx-rate-poller';

const T0 = Date.UTC(2026, 8, 28, 14, 0, 0);

function source(readings: (FxQuoteReading | Error)[]): FxQuoteSource {
  return {
    getFxQuote: async () => {
      const next = readings.shift();

      if (!next || next instanceof Error) {
        throw next ?? new Error('no more readings');
      }

      return next;
    },
  };
}

const QUOTE: FxQuoteReading = { base: 'USD', quote: 'CAD', bid: 1.387, ask: 1.3874 };

let warn: jest.SpyInstance;
let log: jest.SpyInstance;

beforeEach(() => {
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('FxRatePoller', () => {
  it('records the ask, stamped with this process clock', async () => {
    const clock = { t: T0 };
    const book = new FxRateBook('USD', 'CAD', () => clock.t);

    await new FxRatePoller(source([QUOTE]), book, 60_000, () => clock.t).poll();

    expect(book.snapshot()).toMatchObject({ status: FxStatus.FRESH, rate: 1.3874, ageMs: 0 });
  });

  it('lets the last rate age out when polls fail, rather than extending its life', async () => {
    const clock = { t: T0 };
    const book = new FxRateBook('USD', 'CAD', () => clock.t);
    const poller = new FxRatePoller(
      source([QUOTE, new Error('IB not connected'), new Error('IB not connected')]),
      book,
      60_000,
      () => clock.t,
    );

    await poller.poll();
    clock.t += 120_000;
    await poller.poll();
    clock.t += FX_MAX_AGE_MS;
    await poller.poll();

    expect(book.snapshot().status).toBe(FxStatus.STALE);
    expect(book.snapshot().lastError).toBe('IB not connected');
  });

  it('warns once per outage and logs the recovery', async () => {
    const book = new FxRateBook('USD', 'CAD');
    const poller = new FxRatePoller(source([new Error('down'), new Error('down'), QUOTE]), book);

    await poller.poll();
    await poller.poll();
    expect(warn).toHaveBeenCalledTimes(1);

    await poller.poll();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('recovered'));
  });

  it('never throws out of a poll, even from a broker with no FX capability', async () => {
    const book = new FxRateBook('USD', 'CAD');

    await expect(new FxRatePoller({}, book).poll()).resolves.toBeUndefined();
    expect(book.snapshot().lastError).toContain('cannot quote USD.CAD');
  });

  it('polls immediately on start, then on its interval, and stops cleanly', async () => {
    jest.useFakeTimers();

    try {
      const getFxQuote = jest.fn().mockResolvedValue(QUOTE);
      const poller = new FxRatePoller({ getFxQuote }, new FxRateBook('USD', 'CAD'), 1_000);

      poller.start();
      poller.start();
      expect(getFxQuote).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(2_000);
      expect(getFxQuote).toHaveBeenCalledTimes(3);

      poller.stop();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(getFxQuote).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('gets a fresh rate from the mock broker, which the replay path depends on', async () => {
    const book = new FxRateBook('USD', 'CAD');

    await new FxRatePoller(new MockBrokerAdapter(), book).poll();

    expect(book.snapshot().status).toBe(FxStatus.FRESH);
  });

  it('reports a pair the mock broker was not configured with as unavailable', async () => {
    const book = new FxRateBook('USD', 'CAD');

    await new FxRatePoller(new MockBrokerAdapter({ fxRates: {} }), book).poll();

    expect(book.snapshot().status).toBe(FxStatus.UNAVAILABLE);
  });
});
