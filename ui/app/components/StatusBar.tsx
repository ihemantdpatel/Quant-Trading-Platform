/**
 * Connection health, equity, and live P&L (`PRD.md:377`).
 *
 * Account equity is reported as unavailable rather than as a number, because
 * the mock broker exposes positions but the per-symbol allocation that would
 * scale them is a deliberately-unset Story 13 item (`PRD.md:500`). Showing a
 * plausible-looking figure here would be inventing one, and this panel sits
 * beside real prices where a fabricated number is worse than a blank.
 */

import { formatCurrency, type Position, type Status } from '../lib/api';

export function StatusBar({
  status,
  positions,
  deployed,
  realized,
  positionsUnavailable = false,
}: {
  status: Status | null;
  positions: Position[];
  deployed: number;
  realized: number;
  /**
   * True when the `/positions` read failed.
   *
   * This is the field where conflating "unknown" with "empty" is most
   * dangerous: an unreachable broker would otherwise render as **flat**, which
   * is the same word a genuinely empty account gets. An operator reading
   * "flat" during a broker outage concludes they have no exposure.
   */
  positionsUnavailable?: boolean;
}) {
  const connected = status?.broker.connected ?? false;

  return (
    <section
      aria-label="Status"
      className="grid gap-3 rounded-lg border border-slate-800 bg-slate-900 p-4 sm:grid-cols-2 lg:grid-cols-5"
    >
      <Item label="Broker">
        <span className={connected ? 'text-emerald-400' : 'text-red-400'}>
          {status ? `${status.broker.name} · ${status.broker.state}` : 'unknown'}
        </span>
      </Item>

      <Item label="Open positions">
        {positionsUnavailable ? (
          <span className="text-amber-400" title="The broker could not be asked">
            unavailable
          </span>
        ) : positions.length === 0 ? (
          'flat'
        ) : (
          positions.map((p) => `${p.quantity} ${p.symbol}`).join(', ')
        )}
      </Item>

      <Item label="Deployed at cost">{formatCurrency(deployed)}</Item>

      <Item label="Realized P&L">
        <span className={realized >= 0 ? 'text-emerald-400' : 'text-red-400'}>
          {formatCurrency(realized)}
        </span>
      </Item>

      <Item label="Account equity">
        {/*
          Not available from the mock broker, and not guessable. Story 13 sets
          the capital figures this would be measured against.
        */}
        <span className="text-slate-500" title="Set at Story 13 (PRD.md:500)">
          not set
        </span>
      </Item>
    </section>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="font-mono text-sm text-slate-300">{children}</p>
    </div>
  );
}
