/**
 * The shell for one account — everything on these pages acts on this account
 * and nothing else.
 *
 * The kill switch, alert banner, and order controls moved here from the root
 * layout when accounts arrived: each belongs to one daemon, and a kill switch
 * that did not say which account it halts is not a control an operator can
 * trust. They still render on **every** page of the account, which is the
 * property the root layout used to guarantee for the whole dashboard.
 *
 * **This component must never throw**, for the reason the root layout gives:
 * `loadStatus` degrades to `{status: null, error}`, including when no reachable
 * daemon claims this account, and `KillSwitch` renders armed and clickable from
 * those defaults. Its action then reports that the account could not be
 * reached, rather than the control disappearing.
 *
 * `AccountProvider` is what hands the account to every client control below,
 * so each Server Action names its target explicitly (`actions.ts`).
 */

import { AccountProvider } from '../../components/AccountContext';
import { AlertBanner } from '../../components/AlertBanner';
import { KillSwitch } from '../../components/KillSwitch';
import { PendingOrders } from '../../components/PendingOrders';
import { ReconcileButton } from '../../components/ReconcileButton';
import { loadStatus } from '../../lib/api';

export default async function AccountLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ accountId: string }>;
}) {
  const { accountId } = await params;
  const account = decodeURIComponent(accountId);
  const { status, error } = await loadStatus(account);
  const killSwitch = status?.halts.killSwitch;

  /*
    The instrument shown is the one the feed is actually delivering, read
    straight from the broker's last bar; `TQQQ` is the label before any bar has
    arrived (and under the mock broker, which has no live feed).
  */
  const last = status?.broker.lastPrices?.[0] ?? null;

  return (
    <AccountProvider account={account}>
      <div className="flex flex-col gap-4">
        <AlertBanner status={status} error={error} />

        {/* Always visible, and rendered even when the backend read failed. */}
        <KillSwitch
          engaged={killSwitch?.engaged ?? false}
          reason={killSwitch?.reason ?? null}
          changedAt={killSwitch?.changedAt ?? null}
          symbol={last?.symbol ?? 'TQQQ'}
          lastPrice={last}
        />

        {/*
          Beside each other rather than in `EngineControls`: these controls are
          least useful against fixtures and most useful against a live Gateway,
          so they must not share that component's hidden-when-IB-is-bound gate.
        */}
        <div className="grid gap-4 lg:grid-cols-2">
          <ReconcileButton
            lastRun={status?.orderReconciliation ?? null}
            gridLastRun={status?.gridOrderReconciliation ?? null}
          />
          <PendingOrders />
        </div>

        {children}
      </div>
    </AccountProvider>
  );
}
