/**
 * `npm run recover:lots -- --symbol TQQQ`
 *
 * **A one-off operator tool for a position stranded by a dropped fill.**
 *
 * The situation it exists for: an entry order filled at IB while the daemon was
 * down. Before `EngineService.recoverWorkingOrder`, such a fill arrived with no
 * in-memory working-order record and was discarded — no `Fill` row, no lot. The
 * shares exist, the database holds nothing, and startup reconciliation halts the
 * symbol on the lot-sum assertion (`PRD.md:343`).
 *
 * The engine fix stops this recurring, but it cannot repair a position already
 * stranded: IB replays only the *current day's* executions, so once that window
 * has passed the true fill prices are gone from the wire. The evidence that
 * survives is the `Order` row and the `WORKING` rung that placed it.
 *
 * ## Relationship to `LotRebuildService`
 *
 * `ReconciliationService` now runs this same reconstruction automatically
 * (`../reconciliation/lot-rebuild.service.ts`, sharing this arithmetic via
 * `lot-recovery-plan.ts`), and falls back to a synthetic blended-cost lot when
 * an exact reconstruction isn't possible — a deliberate, explicitly reviewed
 * reversal of this script's original reasoning (`docs/decisions/auto-lot-rebuild.md`
 * has the tradeoffs). That automatic path is gated to `PAPER` only. This script
 * remains the manual repair path for everything the automatic one can't or
 * shouldn't reach unattended: a `LIVE` account, a mismatch stale enough that no
 * order records survive to reconstruct from, or a symbol an operator wants to
 * inspect before writing anything. It runs when an operator decides it applies,
 * prints what it would write, and writes only when told twice — the automatic
 * path's synthetic fallback has no equivalent pause, which is exactly why it is
 * confined to `PAPER` for now.
 *
 * ## What it reconstructs, and how wrong it can be
 *
 * Each recovered lot takes **its own order's limit price** as its fill price.
 * A buy limit fills at or below its limit, so every target errs *high*: the lot
 * is held marginally longer and is never sold below a true take-profit. The
 * blended alternative — the broker's `averageCost` for the whole position —
 * would give every lot an identical target and collapse the per-lot exits the
 * ladder exists to produce, so it is used as a **check** rather than a source:
 * the quantity-weighted limit price must be at or above `averageCost`, or the
 * orders do not explain the position and nothing is written.
 *
 * ## What it refuses
 *
 * - A symbol that is not halted, or halted for a reason other than a lot-sum
 *   mismatch — the halt is the evidence that this situation is the one at hand.
 * - Any lot already recorded for the symbol. This repairs an empty ledger; it
 *   never merges with an existing one.
 * - Recovered quantities that do not sum **exactly** to the broker position.
 *   A residual means shares nobody can attribute — a manual trade, a corporate
 *   action — and composition is then genuinely unknown.
 */

import { PrismaClient } from '@prisma/client';
import {
  ACCOUNTS,
  activeAccountAlias,
  environmentAccount,
  findAccount,
} from '../config/accounts.config';
import {
  buildRecoveryPlan,
  refuseReason,
  ProposedLot,
  RecoveryPlan,
} from '../reconciliation/lot-recovery-plan';

export { buildRecoveryPlan, refuseReason, ProposedLot, RecoveryPlan };

export const RECOVER_LOTS_USAGE = `Usage: npm run recover:lots -- --symbol <SYMBOL> [options]

Reconstructs held lots for a position stranded by a dropped fill, from the
persisted BUY orders whose rungs are still WORKING.

Options:
  --symbol <SYMBOL>       Symbol to recover (required)
  --broker-quantity <N>   Net position at the broker. Required: the script does
                          not connect to IB, so the operator supplies the figure
                          they are reconciling against.
  --average-cost <PRICE>  Broker's average cost for the position. Optional; when
                          given, the weighted reconstruction is validated
                          against it and refuses to write if it lands below.
  --take-profit <PCT>     Take-profit fraction (default 0.05).
  --account <ALIAS>       Account whose ledger to repair (default: ACCOUNT_ALIAS,
                          else the default account). Must name an entry in
                          accounts.config.ts.
  --apply                 Write the lots. Without this the script only reports.
  --help, -h              Show this message.
`;

export interface RecoverLotsArgs {
  /** The account alias whose rows are read and written — never any other's. */
  account: string;
  symbol: string;
  brokerQuantity: number;
  averageCost: number | null;
  takeProfitPercent: number;
  apply: boolean;
}

export function parseRecoverLotsArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): RecoverLotsArgs {
  const value = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
  };

  const symbol = value('--symbol');

  if (!symbol) {
    throw new Error('--symbol is required');
  }

  const rawQuantity = value('--broker-quantity');

  if (rawQuantity === null) {
    throw new Error('--broker-quantity is required — it is the figure being reconciled against');
  }

  const brokerQuantity = Number(rawQuantity);

  if (!Number.isInteger(brokerQuantity) || brokerQuantity <= 0) {
    throw new Error(`--broker-quantity must be a positive whole number, got ${rawQuantity}`);
  }

  const rawAverage = value('--average-cost');
  const averageCost = rawAverage === null ? null : Number(rawAverage);

  if (averageCost !== null && (!Number.isFinite(averageCost) || averageCost <= 0)) {
    throw new Error(`--average-cost must be a positive number, got ${rawAverage}`);
  }

  const rawTakeProfit = value('--take-profit');
  const takeProfitPercent = rawTakeProfit === null ? 0.05 : Number(rawTakeProfit);

  if (!Number.isFinite(takeProfitPercent) || takeProfitPercent <= 0) {
    throw new Error(`--take-profit must be a positive number, got ${rawTakeProfit}`);
  }

  // Defaults to the daemon's own account, so running the script inside that
  // daemon's container repairs the ledger that daemon trades. An unknown alias
  // is refused rather than defaulted: repairing the wrong account's ledger
  // would attach lots to shares held somewhere else entirely.
  const account = value('--account') ?? activeAccountAlias(env);

  // A dashboard-created account is known to this process only through the
  // ACCOUNT_DEFINITION its supervisor passed, so it is accepted only as the
  // daemon's own account — run the script with that daemon's environment.
  if (findAccount(account) === null && environmentAccount(env)?.alias !== account) {
    throw new Error(
      `--account "${account}" is not in accounts.config.ts (known: ${Object.keys(ACCOUNTS).join(', ')})`,
    );
  }

  return {
    account,
    symbol,
    brokerQuantity,
    averageCost,
    takeProfitPercent,
    apply: argv.includes('--apply'),
  };
}

/* istanbul ignore next -- I/O wrapper; the decisions above are covered */
export async function runRecoverLots(
  argv: string[],
  out: NodeJS.WritableStream = process.stdout,
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    out.write(`${RECOVER_LOTS_USAGE}\n`);
    return 0;
  }

  let args: RecoverLotsArgs;

  try {
    args = parseRecoverLotsArgs(argv);
  } catch (error) {
    out.write(`${(error as Error).message}\n\n${RECOVER_LOTS_USAGE}\n`);
    return 1;
  }

  if (!process.env.DATABASE_URL) {
    out.write('DATABASE_URL is not set — there is no durable ledger to repair.\n');
    return 1;
  }

  const prisma = new PrismaClient();

  try {
    const accountId = args.account;
    const existing = await prisma.lot.findMany({ where: { accountId, symbol: args.symbol } });

    if (existing.length > 0) {
      out.write(
        `${args.symbol}: ${existing.length} lot(s) already recorded. This script repairs an ` +
          'empty ledger and will not merge with an existing one — resolve by hand.\n',
      );
      return 1;
    }

    const rungs = await prisma.rung.findMany({ where: { accountId, symbol: args.symbol } });
    const workingRungs = rungs.filter((rung) => rung.workingOrderId !== null);
    const rungByOrder = new Map(
      workingRungs.map((rung) => [rung.workingOrderId!, Number(rung.price)]),
    );

    const orders = await prisma.order.findMany({
      where: { accountId, symbol: args.symbol, side: 'BUY' },
    });

    const strandedOrders = orders.filter((order) => rungByOrder.has(order.clientOrderId));

    // Every stranded order belongs to the same per-symbol ladder, so the first
    // names the strategy whose snapshot carries the anchor scalars.
    const strategyId = strandedOrders[0]?.strategyId ?? null;

    const stranded = strandedOrders.map((order) => ({
      clientOrderId: order.clientOrderId,
      quantity: order.quantity,
      limitPrice: Number(order.limitPrice),
      createdAt: order.createdAt,
    }));

    const plan = buildRecoveryPlan(
      args.symbol,
      stranded,
      (id) => rungByOrder.get(id)!,
      args.takeProfitPercent,
    );

    out.write(`\n${args.symbol} (account ${accountId}) — proposed reconstruction\n\n`);

    for (const lot of plan.lots) {
      out.write(
        `  ${lot.id.padEnd(16)} ${String(lot.quantity).padStart(5)} sh  @ ` +
          `${lot.fillPrice.toFixed(2).padStart(9)}  rung ${lot.rungPrice.toFixed(2).padStart(9)}` +
          `  exits ${lot.exitTarget.toFixed(2).padStart(9)}  (${lot.clientOrderId})\n`,
      );
    }

    out.write(
      `\n  recovered ${plan.recoveredQuantity} share(s) against broker ${args.brokerQuantity}\n` +
        `  weighted fill ${plan.weightedFillPrice.toFixed(4)}` +
        (args.averageCost === null
          ? '  (no --average-cost given: not validated)\n'
          : `  vs broker average ${args.averageCost.toFixed(4)}\n`) +
        `  hard floor anchored at ${plan.firstEntryPrice.toFixed(2)}\n\n`,
    );

    const refusal = refuseReason(plan, args.brokerQuantity, args.averageCost);

    if (refusal) {
      out.write(`REFUSED — ${refusal}\n`);
      return 1;
    }

    if (!args.apply) {
      out.write('Dry run. Re-run with --apply to write these lots.\n');
      return 0;
    }

    await prisma.$transaction(async (tx) => {
      for (const lot of plan.lots) {
        await tx.lot.create({
          data: {
            accountId,
            id: lot.id,
            symbol: lot.symbol,
            rungPrice: lot.rungPrice,
            fillPrice: lot.fillPrice,
            quantity: lot.quantity,
            openedAt: lot.openedAt,
            exitTarget: lot.exitTarget,
            status: 'HELD',
            closedAt: null,
            exitPrice: null,
          },
        });

        // The rung now holds the lot rather than a working order. Left WORKING,
        // reconciliation would look for an order at IB that filled long ago and
        // release the level, and the ladder would re-enter on top of shares it
        // already holds.
        await tx.rung.update({
          where: {
            accountId_symbol_price: { accountId, symbol: lot.symbol, price: lot.rungPrice },
          },
          data: { status: 'HELD', lotId: lot.id, workingOrderId: null },
        });

        await tx.order.update({
          where: { accountId_clientOrderId: { accountId, clientOrderId: lot.clientOrderId } },
          data: { status: 'FILLED' },
        });
      }

      // **The snapshot's `firstEntryPrice` must be written too, or the -25%
      // hard floor silently disappears.** It is set only when a lot opens
      // (`dip-ladder.strategy.ts:346`) and is never recomputed from restored
      // lots — reconciliation copies it straight out of the snapshot
      // (`reconciliation.service.ts:378`). A recovered position whose snapshot
      // still says null would therefore run with `hardFloorPrice` returning
      // null for the life of the cycle, which reads as "flat, floor cannot
      // bind" (`invalidation.ts:46`) on a ladder that is anything but.
      const snapshot = strategyId
        ? await tx.strategyStateSnapshot.findFirst({
            where: { accountId, strategyId },
            orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
          })
        : null;

      if (snapshot) {
        // `data` is a Json column: Prisma hands back the parsed value, not a
        // string, so it is spread rather than JSON.parse'd.
        const data = { ...(snapshot.data as Record<string, unknown>) };

        data.firstEntryPrice = plan.firstEntryPrice;
        data.lotSequence = plan.lots.length;

        // Appended rather than updated: snapshots are append-per-save so a
        // crash mid-write leaves the previous good one readable, and rewriting
        // history would destroy the record of what the ladder actually held.
        await tx.strategyStateSnapshot.create({
          data: {
            accountId,
            strategyId: snapshot.strategyId,
            version: snapshot.version,
            symbols: snapshot.symbols ?? [args.symbol],
            capturedAt: new Date().toISOString(),
            data: data as object,
          },
        });
      }
    });

    out.write(
      `Wrote ${plan.lots.length} lot(s).\n\n` +
        'Next: restart the daemon so reconciliation re-runs against the repaired ledger,\n' +
        `then release the halt with:\n\n  curl -X POST localhost:3000/halts/${args.symbol}/release\n\n` +
        `The snapshot's firstEntryPrice was set to ${plan.firstEntryPrice.toFixed(2)}, which is\n` +
        'what the -25% hard floor is measured from. Verify GET /lots and GET /rungs before\n' +
        'the next session.\n',
    );

    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

/* istanbul ignore if -- entrypoint */
if (require.main === module) {
  void runRecoverLots(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
