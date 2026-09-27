/**
 * Story 15 — the live flag and the reduced-size period.
 *
 * The properties that matter are refusals: LIVE refused while the flag is
 * unset, FULL refused without a recorded decision, and no path from the
 * passage of time to a larger order.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { ExecutionMode } from './execution-mode';
import {
  LIVE_REDUCED_SIZE_MULTIPLIER,
  LIVE_SIZE_STAGE,
  LIVE_STEP_UP_RECORD,
  LIVE_TRADING_ENABLED,
  LiveSizeStage,
  liveSizeMultiplier,
} from './live.config';
import {
  ACCOUNT_CURRENCY,
  ACCOUNT_EQUITY,
  ACCOUNT_DAILY_LOSS_BASIS,
  ACCOUNT_DAILY_LOSS_THRESHOLD,
  ACCOUNT_EQUITY_CURRENCY,
  ACCOUNT_SYMBOL_CAPITAL,
} from './capital.config';
import { buildRiskConfig } from '../risk/risk.config';
import { AccountDefinition, findAccount } from './accounts.config';
import { evaluateStartupAssertions } from '../risk/startup-assertions';

/** The risk config `risk.module.ts` would build for a given registry account. */
function riskConfigFor(account: AccountDefinition) {
  return buildRiskConfig({
    accountEquity: account.equity,
    accountCurrency: account.currency,
    equityCurrency: account.equityCurrency,
    dailyLossThreshold: account.dailyLossThreshold,
    dailyLossBasis: account.dailyLossBasis,
    perSymbolLimits: { ...account.symbolCapital },
    allowLiveTrading: LIVE_TRADING_ENABLED,
    liveSizeMultiplier: liveSizeMultiplier(),
  });
}

/** The risk config exactly as `risk.module.ts` builds it. */
function shippedRiskConfig() {
  return buildRiskConfig({
    accountEquity: ACCOUNT_EQUITY,
    accountCurrency: ACCOUNT_CURRENCY,
    equityCurrency: ACCOUNT_EQUITY_CURRENCY,
    dailyLossThreshold: ACCOUNT_DAILY_LOSS_THRESHOLD,
    dailyLossBasis: ACCOUNT_DAILY_LOSS_BASIS,
    perSymbolLimits: ACCOUNT_SYMBOL_CAPITAL,
    allowLiveTrading: LIVE_TRADING_ENABLED,
    liveSizeMultiplier: liveSizeMultiplier(),
  });
}

describe('the shipped live settings', () => {
  it('enables LIVE — the operator decision recorded in live-cutover.md', () => {
    expect(LIVE_TRADING_ENABLED).toBe(true);
  });

  it('boots the live account in LIVE', () => {
    const live = findAccount('live')!;
    const result = evaluateStartupAssertions(
      ExecutionMode.LIVE,
      riskConfigFor(live),
      { TQQQ: live.symbolCapital.TQQQ },
      ['USD'],
      live,
    );

    expect(result.failures).toEqual([]);
  });

  it('refuses the live account in PAPER, and the paper account in LIVE', () => {
    // The flag permits LIVE; each account's allowedModes decides who may use it.
    const live = findAccount('live')!;
    const paper = findAccount('nuuixl118')!;

    const livePaper = evaluateStartupAssertions(
      ExecutionMode.PAPER,
      riskConfigFor(live),
      { TQQQ: live.symbolCapital.TQQQ },
      ['USD'],
      live,
    );
    const paperLive = evaluateStartupAssertions(
      ExecutionMode.LIVE,
      shippedRiskConfig(),
      { TQQQ: ACCOUNT_SYMBOL_CAPITAL.TQQQ },
      ['USD'],
      paper,
    );

    expect(livePaper.failures.join('\n')).toMatch(/may not run in PAPER/);
    expect(paperLive.failures.join('\n')).toMatch(/may not run in LIVE/);
  });

  it('still permits PAPER with the same configuration', () => {
    const result = evaluateStartupAssertions(
      ExecutionMode.PAPER,
      shippedRiskConfig(),
      { TQQQ: ACCOUNT_SYMBOL_CAPITAL.TQQQ },
      ['USD'],
    );

    expect(result.failures).toEqual([]);
  });

  it('starts live trading at 25% of nominal', () => {
    expect(LIVE_SIZE_STAGE).toBe(LiveSizeStage.REDUCED);
    expect(LIVE_REDUCED_SIZE_MULTIPLIER).toBe(0.25);
    expect(LIVE_STEP_UP_RECORD).toBeNull();
    expect(liveSizeMultiplier()).toBe(0.25);
  });
});

describe('the step-up rule', () => {
  it('requires a recorded decision to reach full size', () => {
    expect(() => liveSizeMultiplier(LiveSizeStage.FULL, null)).toThrow(/explicit, recorded/);
    expect(() => liveSizeMultiplier(LiveSizeStage.FULL, '   ')).toThrow(/explicit, recorded/);
    expect(liveSizeMultiplier(LiveSizeStage.FULL, '2026-10-12 live-cutover.md#step-up')).toBe(1);
  });

  it('does not step up with the passage of time', () => {
    jest.useFakeTimers({ now: new Date('2027-06-01T15:00:00Z') });

    try {
      // A year after any plausible cutover, still reduced — nothing counts
      // down to full size.
      expect(liveSizeMultiplier()).toBe(0.25);
      expect(liveSizeMultiplier(LiveSizeStage.REDUCED, 'a record alone is not a step-up')).toBe(
        0.25,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('reads no clock and schedules nothing', () => {
    // The test above proves the current code; this one stops a future edit
    // from adding a date-driven step-up that the fake clock happens to miss.
    const source = readFileSync(join(__dirname, 'live.config.ts'), 'utf8').replace(
      /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      '',
    );

    expect(source).not.toMatch(/\bDate\b|setTimeout|setInterval|performance\.now|luxon/);
  });

  it('cannot be configured to enlarge orders', () => {
    expect(() => buildRiskConfig({ liveSizeMultiplier: 1.5 })).toThrow(/never enlarge/);
    expect(() => buildRiskConfig({ liveSizeMultiplier: 0 })).toThrow();
    expect(() => buildRiskConfig({ liveSizeMultiplier: Number.NaN })).toThrow();
  });
});
