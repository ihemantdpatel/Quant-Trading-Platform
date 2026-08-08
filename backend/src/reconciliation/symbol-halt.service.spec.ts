/**
 * The per-symbol halt registry.
 *
 * The interesting assertions here are the negative ones: a halt must be
 * per-symbol (not global), must not expire, and must not offer any path that
 * could be mistaken for "resolve it by trading out of it".
 */

import { SymbolHaltService } from './symbol-halt.service';

describe('SymbolHaltService', () => {
  let halts: SymbolHaltService;

  beforeEach(() => {
    halts = new SymbolHaltService();
    // The logger's error output is expected here — a halt is supposed to be
    // loud. Silenced so the suite output stays readable.
    jest.spyOn(halts['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(halts['logger'], 'warn').mockImplementation(() => undefined);
  });

  it('starts with nothing halted', () => {
    expect(halts.active()).toEqual([]);
    expect(halts.isHalted('TQQQ')).toBe(false);
  });

  it('halts a symbol with its reason, code, and timestamp', () => {
    halts.halt(
      'TQQQ',
      'LOT_SUM_MISMATCH',
      'lot sum 300 != broker 200',
      '2025-01-02T09:30:00.000-05:00',
    );

    expect(halts.isHalted('TQQQ')).toBe(true);
    expect(halts.haltFor('TQQQ')).toEqual({
      symbol: 'TQQQ',
      code: 'LOT_SUM_MISMATCH',
      reason: 'lot sum 300 != broker 200',
      at: '2025-01-02T09:30:00.000-05:00',
    });
  });

  it('halts one symbol without affecting another', () => {
    // `stories.md:558` — "other symbols unaffected" is the property that makes
    // a halt a targeted response rather than an outage.
    halts.halt('TQQQ', 'LOT_SUM_MISMATCH', 'mismatch', 'now');

    expect(halts.isHalted('TQQQ')).toBe(true);
    expect(halts.isHalted('SOXL')).toBe(false);
    expect(halts.haltedSymbols()).toEqual(['TQQQ']);
  });

  it('keeps the first reason when halted again', () => {
    // The original cause is the one that explains the state. A later generic
    // halt overwriting "lot sum 300 != 200" with "reconciliation failed" would
    // discard exactly the detail needed to resolve it.
    halts.halt('TQQQ', 'LOT_SUM_MISMATCH', 'specific original cause', 'first');
    const second = halts.halt('TQQQ', 'OTHER', 'vaguer later cause', 'second');

    expect(second.reason).toBe('specific original cause');
    expect(second.at).toBe('first');
    expect(halts.active()).toHaveLength(1);
  });

  it('releases a halt only on explicit operator action', () => {
    halts.halt('TQQQ', 'LOT_SUM_MISMATCH', 'mismatch', 'then');

    expect(halts.release('TQQQ', 'now')).toBe(true);
    expect(halts.isHalted('TQQQ')).toBe(false);
  });

  it('reports false when releasing a symbol that was not halted', () => {
    // Lets the HTTP layer answer 404 rather than claiming it cleared something.
    expect(halts.release('TQQQ', 'now')).toBe(false);
  });

  it('does not release on the passage of time', () => {
    // There is no TTL and no timer, deliberately: a halt that expired on its
    // own would resume trading against state nobody re-checked. Asserted by
    // advancing the clock a full day and confirming the halt stands.
    jest.useFakeTimers();

    try {
      halts.halt('TQQQ', 'LOT_SUM_MISMATCH', 'mismatch', 'then');
      jest.advanceTimersByTime(24 * 60 * 60 * 1000);

      expect(halts.isHalted('TQQQ')).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('exposes every active halt for the status endpoint', () => {
    halts.halt('TQQQ', 'LOT_SUM_MISMATCH', 'a', 'now');
    halts.halt('SOXL', 'STATE_VERSION_MISMATCH', 'b', 'now');

    expect(
      halts
        .active()
        .map((halt) => halt.symbol)
        .sort(),
    ).toEqual(['SOXL', 'TQQQ']);
  });
});
