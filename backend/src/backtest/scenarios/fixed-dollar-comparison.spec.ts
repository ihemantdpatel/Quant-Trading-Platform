/**
 * Comparative backtest: the current percentage ladder against the proposed
 * fixed-dollar one, over the committed drawdown scenarios.
 *
 * This is a *reporting* spec — it prints a comparison for an operator to read
 * before deciding whether to adopt $1 spacing live. Its assertions are
 * deliberately weak (the arithmetic is asserted in `fixed-dollar.spec.ts`);
 * what matters here is the printed table.
 */

import { runBacktest } from '../replay-harness';
import { computeStatistics } from '../statistics';
import { TQQQ_2022, TQQQ_2020, SYNTHETIC_3X_2000, buildDrawdownBars } from './drawdown-fixtures';
import { SpacingMode, DipLadderConfig } from '../../strategies/dip-ladder/config';
import { BarSize } from '../../market-data/types';

const SYMBOL_CAPITAL = 40_000;
const ACCOUNT_EQUITY = 175_000;

const CONFIGS: {
  label: string;
  ladder: Partial<Omit<DipLadderConfig, 'symbol' | 'symbolCapital'>>;
}[] = [
  { label: 'current   5% spacing / capital-sized', ladder: {} },
  {
    label: 'proposed  $1 spacing / 50 shares',
    ladder: {
      spacingMode: SpacingMode.FIXED_DOLLAR,
      spacingDollars: 1,
      takeProfitDollars: 1,
      fixedQuantity: 50,
    },
  },
];

const SCENARIOS = [
  { name: 'TQQQ 2022 — sustained bear', shape: TQQQ_2022 },
  { name: 'TQQQ 2020 — crash and recovery', shape: TQQQ_2020 },
  { name: 'Synthetic 3x 2000 — dot-com', shape: SYNTHETIC_3X_2000 },
];

describe('fixed-dollar vs percentage ladder', () => {
  jest.setTimeout(300_000);

  it('reports a comparison across the drawdown scenarios', async () => {
    const lines: string[] = [];

    for (const scenario of SCENARIOS) {
      const bars = buildDrawdownBars(scenario.shape);
      const first = bars[0].close;
      const last = bars[bars.length - 1].close;

      lines.push('');
      lines.push('='.repeat(76));
      lines.push(
        `${scenario.name}  (${bars.length} bars, $${first.toFixed(2)} → $${last.toFixed(2)})`,
      );
      lines.push('='.repeat(76));

      for (const cfg of CONFIGS) {
        const result = await runBacktest({
          symbol: 'TQQQ',
          barSize: '5 mins' as BarSize,
          bars,
          symbolCapital: SYMBOL_CAPITAL,
          accountEquity: ACCOUNT_EQUITY,
          ladder: cfg.ladder,
        });

        const stats = computeStatistics({
          closedTrades: result.closedTrades,
          equityCurve: result.equityCurve,
          openLotsAtEnd: result.openLots.length,
          commissionPaid: result.commissionPaid,
          startingEquity: ACCOUNT_EQUITY,
          maxConcurrentRungs: 5,
        });

        const heldShares = result.openLots.reduce((sum, lot) => sum + lot.quantity, 0);
        const perTrade = [...new Set(result.closedTrades.map((t) => t.realizedPnl.toFixed(2)))];
        const grossPerTrade = [
          ...new Set(result.closedTrades.map((t) => (t.realizedPnl + t.commission).toFixed(2))),
        ];

        lines.push('');
        lines.push(`  ${cfg.label}`);
        lines.push(`    completed cycles   : ${stats.completedCycles}`);
        lines.push(`    realized P&L (net) : $${stats.totalRealizedPnl.toFixed(2)}`);
        lines.push(`    commission paid    : $${stats.totalCommission.toFixed(2)}`);
        lines.push(`    unrealized at end  : $${stats.finalUnrealizedPnl.toFixed(2)}`);
        lines.push(`    open lots at end   : ${stats.openLotsAtEnd} (${heldShares} shares)`);
        lines.push(`    max drawdown       : ${stats.maxDrawdownPercent.toFixed(2)}%`);
        lines.push(`    max concurrent lots: ${stats.maxConcurrentLots}`);
        lines.push(`    time fully extended: ${(stats.timeAtHardFloorPercent * 100).toFixed(1)}%`);
        lines.push(
          `    gross P&L / trade  : ${
            grossPerTrade.length <= 4
              ? grossPerTrade.map((v) => `$${v}`).join(', ')
              : `${grossPerTrade.length} distinct`
          }`,
        );
        lines.push(
          `    net P&L / trade    : ${
            perTrade.length <= 4
              ? perTrade.map((v) => `$${v}`).join(', ')
              : `${perTrade.length} distinct`
          }`,
        );
      }
    }

    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));

    expect(lines.length).toBeGreaterThan(0);
  });
});
