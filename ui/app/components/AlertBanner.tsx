/**
 * Active alerts and halts (`PRD.md:379`).
 *
 * Rendered at the top of the dashboard, above everything else, because the
 * events it reports — a halted entry path, a failed broker connection, an
 * unreachable backend — change what every other panel below it means. A stale
 * ladder read during an outage looks exactly like a calm one.
 *
 * Both halt kinds state explicitly that **positions are not liquidated**
 * (`PRD.md:316`). That is the system's most important behaviour under fault,
 * and an operator seeing "HALTED" needs to know it means "stopped trading", not
 * "sold everything".
 *
 * The two are worded differently on purpose. An `ENTRY_HALT` stops new entries
 * and still permits exits; a **reconciliation halt stops both**, because lot
 * composition is unverified and FIFO would otherwise sell a lot chosen from
 * records that disagree with the broker (`PRD.md:347`).
 */

import type { EngineAlert, Status } from '../lib/api';

export function AlertBanner({ status, error }: { status: Status | null; error: string | null }) {
  const alerts: EngineAlert[] = status?.alerts ?? [];
  const entryHalt = status?.halts.entryHalt;
  const brokerDown = status ? !status.broker.connected : false;
  const symbolHalts = status?.halts.symbols ?? [];

  const hasAnything =
    Boolean(error) ||
    alerts.length > 0 ||
    entryHalt?.halted ||
    brokerDown ||
    symbolHalts.length > 0;

  if (!hasAnything) {
    return null;
  }

  return (
    <div aria-label="Active alerts" role="alert" className="space-y-2">
      {error && (
        <Banner severity="CRITICAL" code="BACKEND_UNREACHABLE">
          {error}. The engine may still be running — this dashboard cannot currently read it.
        </Banner>
      )}

      {entryHalt?.halted && (
        <Banner severity="CRITICAL" code="ENTRY_HALT">
          New entries are halted: {entryHalt.reason ?? 'no reason recorded'}.{' '}
          <strong>Existing positions are held, not liquidated.</strong>
        </Banner>
      )}

      {/*
        Reconciliation halts, listed per symbol. Stated as "no trading" rather
        than "no entries" because this halt blocks exits too — the distinction
        from ENTRY_HALT above is the whole reason it is a separate control, and
        an operator reading the wrong one would expect exits to still fire.
      */}
      {symbolHalts.map((halt) => (
        <Banner key={halt.symbol} severity="CRITICAL" code={halt.code}>
          <strong>{halt.symbol} is halted — no entries and no exits.</strong> {halt.reason}{' '}
          <strong>The position is untouched and will not be liquidated.</strong> Resolve the
          discrepancy manually, then release the halt.
          <span className="text-xs opacity-70"> ({halt.at})</span>
        </Banner>
      ))}

      {brokerDown && (
        <Banner severity="CRITICAL" code="BROKER_DISCONNECTED">
          Broker {status?.broker.name} is {status?.broker.state.toLowerCase()}
          {status?.broker.reconnectAttempts
            ? ` after ${status.broker.reconnectAttempts} reconnect attempt(s)`
            : ''}
          . {status?.broker.lastError ?? ''}
        </Banner>
      )}

      {alerts.map((alert, index) => (
        <Banner
          key={`${alert.code}-${alert.timestamp}-${index}`}
          severity={alert.severity}
          code={alert.code}
        >
          {alert.detail} <span className="text-xs opacity-70">({alert.timestamp})</span>
        </Banner>
      ))}
    </div>
  );
}

function Banner({
  severity,
  code,
  children,
}: {
  severity: EngineAlert['severity'];
  code: string;
  children: React.ReactNode;
}) {
  const critical = severity === 'CRITICAL';

  return (
    <div
      className={`rounded-lg border px-4 py-2.5 text-sm ${
        critical
          ? 'border-red-700 bg-red-950/50 text-red-200'
          : 'border-amber-700 bg-amber-950/50 text-amber-200'
      }`}
    >
      <span className="mr-2 rounded bg-black/30 px-1.5 py-0.5 font-mono text-xs font-semibold">
        {code}
      </span>
      {children}
    </div>
  );
}
