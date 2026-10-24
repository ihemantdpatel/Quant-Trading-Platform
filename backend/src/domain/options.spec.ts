import { contractKey, liquidSessionOpen, validStandardOption } from './options';
import { equityContract, optionContract, OptionRight } from './contract';
const put = optionContract({
  symbol: 'QQQ',
  strike: 500,
  expiry: '2026-11-20',
  right: OptionRight.PUT,
});
it('identifies different option series independently of exchange routing', () => {
  expect(contractKey(put)).not.toBe(contractKey({ ...put, strike: 501 }));
  expect(contractKey(put)).not.toBe(contractKey({ ...put, right: OptionRight.CALL }));
  expect(contractKey(put)).toBe(contractKey({ ...put, exchange: 'CBOE' }));
  expect(contractKey(equityContract('QQQ'))).not.toBe(contractKey(put));
});
it('accepts complete standard USD options and rejects adjusted or incomplete contracts', () => {
  expect(validStandardOption(put)).toBe(true);
  for (const bad of [
    { multiplier: 10 },
    { currency: 'CAD' },
    { strike: -1 },
    { expiry: undefined },
    { right: undefined },
  ]) {
    expect(validStandardOption({ ...put, ...bad })).toBe(false);
  }
});
it('honors exchange holiday closures and early closing hours', () => {
  const hours = '20261126:CLOSED;20261127:0930-20261127:1300';
  expect(liquidSessionOpen(hours, 'US/Eastern', '2026-11-26T16:00:00Z')).toBe(false);
  expect(liquidSessionOpen(hours, 'US/Eastern', '2026-11-27T16:00:00Z')).toBe(true);
  expect(liquidSessionOpen(hours, 'US/Eastern', '2026-11-27T18:00:00Z')).toBe(false);
  expect(liquidSessionOpen('bad-bad', 'US/Eastern', '2026-11-27T16:00:00Z')).toBe(false);
});

import { scanStrikes } from './options';
it('samples enough OTM distance to find low-delta QQQ contracts and honors a call cost floor', () => {
  const strikes = Array.from({ length: 200 }, (_, i) => 450 + i);
  const puts = scanStrikes(strikes, 550, 'P');
  expect(puts.length).toBeLessThanOrEqual(8);
  expect(puts.every((s) => s < 550)).toBe(true);
  expect(Math.min(...puts)).toBeLessThan(500);
  expect(scanStrikes(strikes, 550, 'C', 600).every((s) => s >= 600)).toBe(true);
  expect(scanStrikes([], 550, 'P')).toEqual([]);
  expect(scanStrikes(strikes, 550, 'P', 500).every((s) => s <= 500)).toBe(true);
});
