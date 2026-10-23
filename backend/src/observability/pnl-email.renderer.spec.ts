import { ExecutionMode } from '../config/execution-mode';
import { price, renderDaily, renderPeriod, signedUsd } from './pnl-email.renderer';
import { Coverage, DailyPnl, PeriodPnl } from './pnl-summary';

const account = { alias: 'nuuixl118', mode: ExecutionMode.PAPER };

const full: Coverage = {
  trackedSince: '2026-09-01T16:20:00.000-04:00',
  tracked: true,
  partial: false,
};

const daily: DailyPnl = {
  date: '2026-09-25',
  sells: [
    {
      fillId: 'f1',
      symbol: 'TQQQ',
      timestamp: '2026-09-25T11:05:00.000-04:00',
      quantity: 50,
      price: 70.5,
      averageCost: 70,
      commission: 1,
      gross: 25,
      realized: 24,
      uncovered: 0,
    },
    {
      fillId: 'f2',
      symbol: 'TQQQ',
      timestamp: '2026-09-25T14:00:00.000Z',
      quantity: 10,
      price: 70.5,
      averageCost: 71.1234,
      commission: 1.5,
      gross: -6.23,
      realized: -7.73,
      uncovered: 0,
    },
  ],
  totals: { trades: 2, gross: 18.77, commissions: 2.5, net: 16.27 },
  held: [{ symbol: 'TQQQ', quantity: 150, averageCost: 70.25 }],
  monthToDate: { trades: 40, gross: 1000, commissions: 50, net: 950 },
  coverage: full,
  monthCoverage: full,
  mismatches: [],
};

describe('pnl-email.renderer', () => {
  it('formats signed money and prices', () => {
    expect(signedUsd(1234.5)).toBe('+$1,234.50');
    expect(signedUsd(-12)).toBe('-$12.00');
    expect(signedUsd(0)).toBe('$0.00');
    expect(price(70)).toBe('70.00');
    expect(price(71.1234)).toBe('71.1234');
  });

  describe('renderDaily', () => {
    const email = renderDaily(daily, account);

    it('puts account, mode, realized P&L, and sell count in the subject', () => {
      expect(email.subject).toBe(
        '[IB nuuixl118 · PAPER] Daily P&L · Fri, Sep 25, 2026 (session close): +$16.27 (2 sells)',
      );
    });

    it('prefixes the subject when asked', () => {
      expect(renderDaily(daily, account, { subjectPrefix: '[SAMPLE]' }).subject).toMatch(
        /^\[SAMPLE\] \[IB nuuixl118/,
      );
    });

    it('lists each sell with its price, average cost, commission, and realized P&L', () => {
      for (const body of [email.html, email.text]) {
        expect(body).toContain('70.50');
        expect(body).toContain('71.1234');
        expect(body).toContain('+$24.00');
        expect(body).toContain('-$7.73');
        expect(body).toContain('+$16.27');
        expect(body).toContain('$1.50');
      }
      expect(email.html).toContain('Avg cost');
      expect(email.html).toContain('>10:00<');
    });

    it('explains the average-cost basis', () => {
      expect(email.html).toContain('average-cost method');
      expect(email.text).toContain('average-cost method');
    });

    it('colors a loss red', () => {
      expect(email.html).toMatch(/color:#b91c1c[^>]*>-\$7\.73/);
    });

    it('includes month to date and the closing position', () => {
      expect(email.text).toContain('Month to date: 40 sells · gross +$1,000.00');
      expect(email.text).toContain('TQQQ: 150 sh @ avg 70.25');
    });

    it('says so on a day with no sells rather than rendering an empty table', () => {
      const empty = renderDaily(
        { ...daily, sells: [], totals: { trades: 0, gross: 0, commissions: 0, net: 0 }, held: [] },
        account,
      );

      expect(empty.subject).toContain('$0.00 (0 sells)');
      expect(empty.html).toContain('No sells today.');
      expect(empty.text).toContain('No position held.');
    });

    it('says "not tracked" rather than $0 for a day before tracking began', () => {
      const untracked = renderDaily(
        {
          ...daily,
          sells: [],
          totals: { trades: 0, gross: 0, commissions: 0, net: 0 },
          coverage: { trackedSince: null, tracked: false, partial: false },
        },
        account,
      );

      expect(untracked.subject).toMatch(/: not tracked$/);
      expect(untracked.text).toContain('! Not tracked');
    });

    it('flags a partial month and a snapshot mismatch', () => {
      const flagged = renderDaily(
        {
          ...daily,
          monthCoverage: { ...full, partial: true, trackedSince: '2026-09-24T16:20:00.000-04:00' },
          mismatches: [
            {
              symbol: 'TQQQ',
              takenAt: '2026-09-25T16:20:00.000-04:00',
              replayedQuantity: 100,
              brokerQuantity: 200,
              replayedAverageCost: 80,
              brokerAverageCost: 79.5,
            },
          ],
        },
        account,
      );

      expect(flagged.text).toContain('Partial: average-cost tracking began Sep 24 16:20 ET');
      expect(flagged.text).toContain(
        'IB held 200 sh @ 79.5000, recorded fills explain 100 sh @ 80.0000',
      );
      expect(flagged.html).toContain('a fill is missing');
    });

    it('escapes interpolated strings', () => {
      const hostile = renderDaily(
        { ...daily, held: [{ symbol: '<b>X</b>', quantity: 1, averageCost: 1 }] },
        account,
      );

      expect(hostile.html).toContain('&lt;b&gt;X&lt;/b&gt;');
      expect(hostile.html).not.toContain('<b>X</b>');
    });
  });

  describe('renderPeriod', () => {
    const period: PeriodPnl = {
      from: '2026-09-01',
      to: '2026-09-30',
      days: [{ date: '2026-09-25', trades: 2, gross: 18.77, commissions: 2.5, net: 16.27 }],
      bySymbol: [{ symbol: 'TQQQ', trades: 2, net: 16.27 }],
      totals: { trades: 2, gross: 18.77, commissions: 2.5, net: 16.27 },
      coverage: full,
      mismatches: [],
    };

    it('titles a month by default', () => {
      const email = renderPeriod(period, account);

      expect(email.subject).toBe(
        '[IB nuuixl118 · PAPER] Monthly P&L · September 2026 (Sep 1 – Sep 30, 2026): +$16.27 (2 sells)',
      );
      expect(email.html).toContain('Fri, Sep 25');
      expect(email.text).toContain('2026-09-25  2 sells, gross +$18.77');
      expect(email.text).toContain('TQQQ: 2 sells, realized +$16.27');
    });

    it('uses a custom label for a non-month window', () => {
      expect(renderPeriod(period, account, { periodLabel: 'last 7 days' }).subject).toBe(
        '[IB nuuixl118 · PAPER] P&L · last 7 days (Sep 1 – Sep 30, 2026): +$16.27 (2 sells)',
      );
    });

    it('says so when the period has no sells', () => {
      const empty = renderPeriod(
        {
          ...period,
          days: [],
          bySymbol: [],
          totals: { trades: 0, gross: 0, commissions: 0, net: 0 },
        },
        account,
      );

      expect(empty.html).toContain('No sells in this period.');
      expect(empty.subject).toContain('(0 sells)');
    });

    it('says "not tracked" for a period before tracking began', () => {
      const untracked = renderPeriod(
        { ...period, coverage: { trackedSince: null, tracked: false, partial: false } },
        account,
      );

      expect(untracked.subject).toMatch(/: not tracked$/);
    });
  });
});

describe('subject dates', () => {
  it('writes a range within one year once, and both years across one', () => {
    const { dateRange, longDate } = jest.requireActual('./pnl-email.renderer');

    expect(longDate('2026-09-28')).toBe('Mon, Sep 28, 2026');
    expect(dateRange('2026-09-21', '2026-09-27')).toBe('Sep 21 – Sep 27, 2026');
    expect(dateRange('2026-12-29', '2027-01-04')).toBe('Dec 29, 2026 – Jan 4, 2027');
  });
});
