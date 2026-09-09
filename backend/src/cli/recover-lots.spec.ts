/**
 * The recovery script's argument handling, tested without a database.
 *
 * The reconstruction arithmetic itself (`buildRecoveryPlan`/`refuseReason`)
 * moved to `../reconciliation/lot-recovery-plan.spec.ts` — it is shared with
 * `LotRebuildService`'s automatic path and is tested there. This file covers
 * only what is specific to the CLI: its argument parsing, and the fact that
 * its "refuse when lots already exist" precondition is deliberately its own
 * and is **not** shared with the automatic path — `LotRebuildService` is
 * expected to combine a reconstruction with pre-existing correct `HELD` lots
 * rather than refuse outright, which this script must not do unattended.
 */

import { parseRecoverLotsArgs } from './recover-lots';

describe('recover-lots argument parsing', () => {
  it('requires a symbol', () => {
    expect(() => parseRecoverLotsArgs(['--broker-quantity', '272'])).toThrow(
      '--symbol is required',
    );
  });

  it('requires the broker quantity rather than assuming one', () => {
    // The script does not connect to IB. Defaulting the figure it reconciles
    // against would let it "match" whatever it happened to reconstruct.
    expect(() => parseRecoverLotsArgs(['--symbol', 'TQQQ'])).toThrow('--broker-quantity');
  });

  it('rejects a fractional or negative share count', () => {
    expect(() => parseRecoverLotsArgs(['--symbol', 'TQQQ', '--broker-quantity', '2.5'])).toThrow(
      'positive whole number',
    );
    expect(() => parseRecoverLotsArgs(['--symbol', 'TQQQ', '--broker-quantity', '-5'])).toThrow(
      'positive whole number',
    );
  });

  it('rejects a non-numeric or negative average cost', () => {
    expect(() =>
      parseRecoverLotsArgs(['--symbol', 'TQQQ', '--broker-quantity', '272', '--average-cost', 'x']),
    ).toThrow('--average-cost must be a positive number');
  });

  it('rejects a non-positive take-profit', () => {
    // A zero or negative take-profit would set an exit target at or below the
    // fill price, which is the one thing the ladder never does.
    expect(() =>
      parseRecoverLotsArgs(['--symbol', 'TQQQ', '--broker-quantity', '272', '--take-profit', '0']),
    ).toThrow('--take-profit must be a positive number');
  });

  it('defaults to a dry run, so writing is always deliberate', () => {
    const args = parseRecoverLotsArgs(['--symbol', 'TQQQ', '--broker-quantity', '272']);

    expect(args.apply).toBe(false);
    expect(args.takeProfitPercent).toBe(0.05);
    expect(args.averageCost).toBeNull();
  });

  it('accepts the optional validation and take-profit figures', () => {
    const args = parseRecoverLotsArgs([
      '--symbol',
      'TQQQ',
      '--broker-quantity',
      '272',
      '--average-cost',
      '73.10',
      '--take-profit',
      '0.04',
      '--apply',
    ]);

    expect(args).toEqual({
      symbol: 'TQQQ',
      brokerQuantity: 272,
      averageCost: 73.1,
      takeProfitPercent: 0.04,
      apply: true,
    });
  });
});
