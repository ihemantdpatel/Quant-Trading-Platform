import { buildDipLadderConfig, DEFAULT_DIP_LADDER_CONFIG, ExitMode, SpacingMode } from './config';

describe('dip ladder config', () => {
  describe('defaults', () => {
    it('matches the PRD-recorded values', () => {
      const config = buildDipLadderConfig('TQQQ');

      expect(config).toEqual({
        symbol: 'TQQQ',
        spacingMode: SpacingMode.PERCENTAGE,
        spacingPercent: 0.05,
        atrMultiple: 1,
        atrPeriod: 14,
        takeProfitPercent: 0.05,
        exitMode: ExitMode.PER_LOT,
        sizePerRung: 0.25,
        escalationFactor: 1,
        maxConcurrentRungs: 5,
        hardFloorPercent: 0.25,
        symbolCapital: null,
      });
    });

    /**
     * Escalating size on lower rungs establishes the largest position where
     * there is the most evidence the thesis is wrong (`PRD.md:117`). It is a
     * parameter, and it is off.
     */
    it('defaults escalation off — flat sizing', () => {
      expect(DEFAULT_DIP_LADDER_CONFIG.escalationFactor).toBe(1);
    });

    it('defaults spacing to percentage, with ATR available', () => {
      expect(DEFAULT_DIP_LADDER_CONFIG.spacingMode).toBe(SpacingMode.PERCENTAGE);
    });

    /**
     * Per-lot exits are the default; average-cost is available as a config
     * option but not the default (`PRD.md:159`), because it closes the whole
     * position at one level and forfeits the cycling per-lot exits produce.
     */
    it('defaults to per-lot exits, with average-cost available', () => {
      expect(DEFAULT_DIP_LADDER_CONFIG.exitMode).toBe(ExitMode.PER_LOT);
      expect(Object.values(ExitMode)).toContain(ExitMode.AVERAGE_COST);
    });

    it('defaults the take-profit to +5%, matching rung spacing', () => {
      expect(DEFAULT_DIP_LADDER_CONFIG.takeProfitPercent).toBe(0.05);
      expect(DEFAULT_DIP_LADDER_CONFIG.takeProfitPercent).toBe(
        DEFAULT_DIP_LADDER_CONFIG.spacingPercent,
      );
    });

    /**
     * `PRD.md:112` records the per-symbol capital figure as not yet set. A
     * numeric default here would be exactly the silent default the PRD forbids.
     */
    it('leaves symbol capital unset rather than inventing a figure', () => {
      expect(DEFAULT_DIP_LADDER_CONFIG.symbolCapital).toBeNull();
    });
  });

  it('applies overrides over defaults', () => {
    const config = buildDipLadderConfig('SPY', {
      spacingMode: SpacingMode.ATR,
      spacingPercent: 0.08,
      symbolCapital: 10_000,
    });

    expect(config.symbol).toBe('SPY');
    expect(config.spacingMode).toBe(SpacingMode.ATR);
    expect(config.spacingPercent).toBe(0.08);
    expect(config.symbolCapital).toBe(10_000);
    // Untouched defaults survive.
    expect(config.maxConcurrentRungs).toBe(5);
  });

  describe('validation', () => {
    it('requires a symbol', () => {
      expect(() => buildDipLadderConfig('')).toThrow('requires a symbol');
    });

    it.each([
      [{ spacingPercent: 0 }, 'spacingPercent'],
      [{ spacingPercent: 1 }, 'spacingPercent'],
      [{ spacingPercent: -0.05 }, 'spacingPercent'],
      [{ atrMultiple: 0 }, 'atrMultiple'],
      [{ atrMultiple: -1 }, 'atrMultiple'],
      [{ atrPeriod: 1 }, 'atrPeriod'],
      [{ atrPeriod: 14.5 }, 'atrPeriod'],
      // A non-positive target would let a lot "exit" at or below its fill —
      // the loss-booking exit the strategy does not have.
      [{ takeProfitPercent: 0 }, 'takeProfitPercent'],
      [{ takeProfitPercent: -0.05 }, 'takeProfitPercent'],
      [{ sizePerRung: 0 }, 'sizePerRung'],
      [{ escalationFactor: 0.9 }, 'escalationFactor'],
      [{ maxConcurrentRungs: 0 }, 'maxConcurrentRungs'],
      [{ maxConcurrentRungs: 2.5 }, 'maxConcurrentRungs'],
      [{ hardFloorPercent: 0 }, 'hardFloorPercent'],
      [{ hardFloorPercent: 1 }, 'hardFloorPercent'],
      [{ symbolCapital: 0 }, 'symbolCapital'],
      [{ symbolCapital: -100 }, 'symbolCapital'],
    ])('rejects %o', (overrides, field) => {
      expect(() => buildDipLadderConfig('TQQQ', overrides)).toThrow(field);
    });

    it('accepts escalation set explicitly to a value above 1', () => {
      expect(buildDipLadderConfig('TQQQ', { escalationFactor: 1.5 }).escalationFactor).toBe(1.5);
    });
  });
});
