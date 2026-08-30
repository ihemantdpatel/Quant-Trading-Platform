/**
 * The ladder: every rung with its price and state — held / working / re-armed /
 * armed (`PRD.md:377`).
 *
 * Rungs are ordered highest price first, which is how the ladder is reasoned
 * about: the shallowest rung is the one that fires next on a dip, and the
 * deepest is nearest the hard floor.
 *
 * **`PENDING` is labelled "Armed", not "Pending".** The enum name is the
 * domain's and it stays — but this dashboard also has a "Pending orders" panel,
 * and the word means opposite things in the two places: a `PENDING` rung is one
 * with *no* order anywhere, free to fire. An operator reading a released rung as
 * "an order is pending here" sees a stale ledger where the state is in fact
 * correct — exactly the misreading a DAY order expiring overnight produces,
 * since `clearWorking` returns a never-cycled rung to `PENDING`. "Armed" says
 * the level is ready and nothing is committed to it.
 *
 * **Re-armed is shown distinctly from armed**, because they mean different
 * things to an operator even though both are fireable: a re-armed rung has
 * already completed at least one cycle and booked a realized gain, while an
 * armed rung has never fired. The cycle count is what makes the chop
 * behaviour visible in the browser, which is Story 7's exit criterion.
 *
 * **Working is the one state carrying live broker exposure without a position.**
 * An order is resting at that price and may fill at any moment, so it reads as
 * an active commitment rather than as another flavour of empty — the amber
 * treatment is shared with risk events for that reason. Conflating it with
 * an armed rung would tell an operator the level is merely ready when capital
 * is already committed to it, which is the mistake the header count exists to
 * stop.
 */

import { formatCurrency, type Rung } from '../lib/api';

const STATUS_STYLE: Record<Rung['status'], { label: string; className: string }> = {
  HELD: { label: 'Held', className: 'border-sky-700 bg-sky-950/60 text-sky-300' },
  WORKING: { label: 'Working', className: 'border-amber-700 bg-amber-950/60 text-amber-300' },
  RE_ARMED: {
    label: 'Re-armed',
    className: 'border-emerald-700 bg-emerald-950/60 text-emerald-300',
  },
  PENDING: { label: 'Armed', className: 'border-slate-700 bg-slate-900 text-slate-400' },
};

export function LadderView({
  rungs,
  mark,
  unavailable = false,
}: {
  rungs: Rung[];
  mark: number | null;
  /** True when the `/rungs` read failed — distinct from an unbuilt ladder. */
  unavailable?: boolean;
}) {
  const ordered = [...rungs].sort((a, b) => b.price - a.price);
  const unverified = ordered.some((rung) => rung.unverified);
  const held = ordered.filter((rung) => rung.status === 'HELD').length;
  const working = ordered.filter((rung) => rung.status === 'WORKING').length;
  const cycles = ordered.reduce((sum, rung) => sum + rung.completedCycles, 0);

  return (
    <section aria-label="Ladder" className="rounded-lg border border-slate-800 bg-slate-900">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Ladder</h2>
        <p className="text-xs text-slate-400">
          {held}/5 rungs held
          {working > 0 && <span className="text-amber-400"> · {working} working</span>} · {cycles}{' '}
          completed cycle{cycles === 1 ? '' : 's'}
        </p>
      </header>

      {unverified && (
        <p className="border-b border-amber-800/60 bg-amber-950/40 px-4 py-2 text-xs text-amber-200">
          Some rungs are shown from the <strong>database</strong> because their symbol is halted.
          Nothing is armed while a symbol is halted, whatever a row's status reads.
        </p>
      )}

      {unavailable ? (
        <p className="px-4 py-6 text-sm text-amber-300">
          Ladder unavailable — this read failed. Resting orders at the broker are unaffected.
        </p>
      ) : ordered.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500">
          No rungs yet. The first fires one spacing unit below the session anchor.
        </p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {ordered.map((rung) => {
            const style = STATUS_STYLE[rung.status];

            return (
              <li
                key={`${rung.price}-${rung.lotId ?? 'empty'}`}
                data-testid={`rung-${rung.price}`}
                className="flex items-center justify-between gap-3 px-4 py-2.5"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono text-base text-slate-100">
                    {formatCurrency(rung.price)}
                  </span>
                  <span
                    className={`rounded border px-2 py-0.5 text-xs font-medium ${style.className}`}
                  >
                    {style.label}
                  </span>
                </div>

                <div className="flex items-center gap-4 text-xs text-slate-500">
                  {rung.completedCycles > 0 && (
                    <span>
                      {rung.completedCycles} cycle{rung.completedCycles === 1 ? '' : 's'}
                    </span>
                  )}
                  {mark !== null && (
                    <span className="font-mono">
                      {mark <= rung.price
                        ? 'at or below'
                        : `${formatCurrency(mark - rung.price)} above`}
                    </span>
                  )}
                  {rung.lotId && <span className="font-mono text-slate-600">{rung.lotId}</span>}
                  {rung.workingOrderId && (
                    <span className="font-mono text-amber-600/80">{rung.workingOrderId}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <footer className="border-t border-slate-800 px-4 py-2 text-xs text-slate-500">
        Re-armed rungs return at their <strong className="text-slate-400">original</strong> price
        and do not count against the 5-concurrent limit.
      </footer>
    </section>
  );
}
