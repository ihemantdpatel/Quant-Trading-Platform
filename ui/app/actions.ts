'use server';

/**
 * Control actions — Server Actions, per the repo's Next.js conventions
 * (`WORKING-NOTES.md`): these are mutations from this app's own UI, not
 * endpoints anything external calls.
 *
 * Each one posts to the engine and then revalidates the dashboard, so the page
 * re-reads real state rather than optimistically rendering what it hoped would
 * happen. On a control surface for a system that places real orders, showing an
 * intended state that did not take effect is the failure mode to avoid: the
 * kill switch must read "engaged" only when the backend says it is.
 *
 * Revalidation is **layout-scoped** (`revalidatePath('/', 'layout')`), not
 * `'/'`. The kill switch and alert banner live in the root layout so they
 * render on every tab; a page-scoped call would refresh whichever tab is open
 * and leave the shell above it — including that kill switch — showing state the
 * backend has already moved past.
 *
 * Failures are returned, never thrown. A refused mode switch carries the
 * assertion failures that blocked it (`stories.md:445`), and those are the
 * whole point of the interaction.
 */

import { revalidatePath } from 'next/cache';
import { loadOrderDiagnosis, post, type OrderDiagnosis } from './lib/api';

export interface ActionResult {
  ok: boolean;
  message: string;
  /** Blocking reasons, when the backend refused and explained why. */
  failures?: string[];
}

function describe(error: unknown): { message: string; failures?: string[] } {
  if (error && typeof error === 'object') {
    const body = error as {
      message?: unknown;
      failures?: unknown;
      detail?: unknown;
    };

    const failures = Array.isArray(body.failures)
      ? body.failures.map((f) => String(f))
      : body.detail && typeof body.detail === 'object'
        ? Object.entries(body.detail as Record<string, unknown>).map(
            ([field, reason]) => `${field}: ${String(reason)}`,
          )
        : undefined;

    if (typeof body.message === 'string') {
      return { message: body.message, failures };
    }

    if (failures) {
      return { message: 'refused by the engine', failures };
    }
  }

  return { message: 'the engine could not be reached' };
}

/**
 * Engages or releases the global kill switch.
 *
 * Effective within one evaluation cycle — the risk manager reads it at the top
 * of every `evaluate()`, so there is no queue to drain (`PRD.md:492`).
 */
export async function setKillSwitch(engaged: boolean, reason?: string): Promise<ActionResult> {
  const result = await post('/kill-switch', {
    engaged,
    reason: reason?.trim() || `operator ${engaged ? 'engaged' : 'released'} via dashboard`,
  });

  revalidatePath('/', 'layout');

  if (!result.ok) {
    const { message, failures } = describe(result.error);
    return { ok: false, message, failures };
  }

  return {
    ok: true,
    message: engaged
      ? 'Kill switch ENGAGED — all new order submission halted.'
      : 'Kill switch released. Submission resumes on the next evaluation cycle.',
  };
}

/**
 * Requests an execution mode change.
 *
 * `PAPER`/`LIVE` are refused while the two open PRD items are unset
 * (`PRD.md:500`); the backend returns the specific failures and this surfaces
 * them rather than reporting a generic error. An operator needs to know *which*
 * value is missing.
 */
export async function setMode(mode: string): Promise<ActionResult> {
  const result = await post<{ detail?: string }>('/mode', { mode });

  revalidatePath('/', 'layout');

  if (!result.ok) {
    const { message, failures } = describe(result.error);
    return { ok: false, message, failures };
  }

  return {
    ok: true,
    message: result.data?.detail ?? `${mode} passes every startup assertion.`,
  };
}

export async function setStrategyEnabled(id: string, enabled: boolean): Promise<ActionResult> {
  const result = await post(
    `/strategies/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`,
    {},
  );

  revalidatePath('/', 'layout');

  if (!result.ok) {
    const { message } = describe(result.error);
    return { ok: false, message };
  }

  return { ok: true, message: `${id} ${enabled ? 'enabled' : 'disabled'}.` };
}

/**
 * Applies a parameter edit.
 *
 * **Future rungs only** (`PRD.md:386`) — the backend freezes every held lot's
 * target and refuses any attempt to retarget a filled rung. This action cannot
 * weaken that: it posts named parameters and surfaces whatever the engine says.
 */
export async function editParameters(
  strategyId: string,
  // `null` is a meaningful value, not an absent one: it clears an optional
  // parameter back to its percentage-based fallback. Omitting a key means
  // "leave unchanged", which is a different request.
  parameters: Record<string, number | string | null>,
  reason?: string,
): Promise<ActionResult> {
  const result = await post<{ changes: unknown[] }>(
    `/parameters/${encodeURIComponent(strategyId)}`,
    { parameters, reason: reason?.trim() || null },
  );

  revalidatePath('/', 'layout');

  if (!result.ok) {
    const { message, failures } = describe(result.error);
    return { ok: false, message, failures };
  }

  const count = result.data?.changes?.length ?? 0;

  return {
    ok: true,
    message:
      count === 0
        ? 'No values changed.'
        : `${count} parameter${count === 1 ? '' : 's'} updated. Held lots keep their existing targets.`,
  };
}

/** Runs a fixture through the engine so the ladder can be watched cycling. */
export async function runReplay(fixture: string): Promise<ActionResult> {
  const result = await post<{ barsProcessed: number; intentsGenerated: number }>('/engine/replay', {
    fixture,
  });

  revalidatePath('/', 'layout');

  if (!result.ok) {
    const { message } = describe(result.error);
    return { ok: false, message };
  }

  return {
    ok: true,
    message: `Replayed ${fixture}: ${result.data?.barsProcessed ?? 0} bars, ${result.data?.intentsGenerated ?? 0} intents.`,
  };
}

/**
 * Re-runs startup reconciliation against the broker on demand.
 *
 * **The repair for state the engine could not learn about on its own.** An
 * order cancelled in TWS, or a DAY order IB expired overnight, leaves a rung
 * marked `WORKING` with nothing behind it whenever the status arrived while
 * this process was not the one that placed the order. Reconciliation already
 * resolves exactly that; until now it ran only at boot, so the fix was a
 * daemon restart mid-session.
 *
 * **This runs the full sequence and can therefore halt a symbol.** The lot-sum
 * assertion is part of it, so a ladder whose lots genuinely disagree with the
 * broker's position will stop trading as a result of pressing this — which is
 * the correct outcome, but not a silent one. The message says so, and the
 * halts it raises appear in the alert banner above.
 *
 * Nothing here can place an order or close a position; `reconcileAll` has no
 * path to either.
 */
export async function reconcileNow(): Promise<ActionResult> {
  const result = await post<{
    clean: boolean;
    haltedSymbols: string[];
    symbols: { symbol: string }[];
    ordersUpdated: number;
  }>('/reconcile', {});

  revalidatePath('/', 'layout');

  if (!result.ok) {
    const { message, failures } = describe(result.error);
    return { ok: false, message, failures };
  }

  const halted = result.data?.haltedSymbols ?? [];
  const corrected = result.data?.ordersUpdated ?? 0;

  // Reported even alongside a halt: an order row corrected from the broker's
  // history is the visible half of the fix an operator pressed this for, and
  // silence about it reads as nothing having happened.
  const orderNote =
    corrected > 0 ? ` ${corrected} stale order row(s) corrected from broker history.` : '';

  // A halt is reported as the failure it is rather than as a successful run,
  // so an operator never reads "reconciled" over a symbol that just stopped
  // trading.
  if (halted.length > 0) {
    return {
      ok: false,
      message:
        `Reconciled — ${halted.length} symbol(s) HALTED and will not trade until released.` +
        orderNote,
      failures: halted,
    };
  }

  return {
    ok: true,
    message:
      `Reconciled ${result.data?.symbols?.length ?? 0} symbol(s) against the broker — clean.` +
      orderNote,
  };
}

/**
 * Reads what rests at the broker against what the ladder believes rests there.
 *
 * **Read-only, and deliberately not `POST /reconcile`.** Asking reconciliation
 * what is wrong changes the answer — it releases rungs, adopts orphans,
 * restores state, and can halt a symbol. An operator deciding whether to
 * intervene needs to see the divergence before anything acts on it.
 *
 * No `revalidatePath`: nothing changed, so there is nothing to re-read.
 */
export async function checkPendingOrders(): Promise<ActionResult & { diagnosis?: OrderDiagnosis }> {
  try {
    const diagnosis = await loadOrderDiagnosis();

    if (!diagnosis.brokerReachable) {
      // Reported as a failure rather than as an empty book. An operator reading
      // "nothing is resting" during an outage would conclude the ladder is
      // unprotected and act on it.
      return {
        ok: false,
        message: `The broker could not be reached, so nothing could be checked.`,
        failures: diagnosis.reason ? [diagnosis.reason] : undefined,
        diagnosis,
      };
    }

    const problems =
      diagnosis.unbacked.length + diagnosis.orphans.length + diagnosis.duplicates.length;

    return {
      ok: true,
      message:
        problems === 0 && diagnosis.missing.length === 0
          ? `${diagnosis.matched.length} resting order(s) — all accounted for.`
          : `${diagnosis.matched.length} matched · ${diagnosis.missing.length} missing · ` +
            `${diagnosis.duplicates.length} duplicate group(s) · ${diagnosis.unbacked.length} unbacked · ` +
            `${diagnosis.orphans.length} orphan(s).`,
      diagnosis,
    };
  } catch (error) {
    const { message } = describe(error);
    return { ok: false, message };
  }
}

/**
 * Places resting orders for the gaps the check identified.
 *
 * **The only control on this dashboard that creates an order.** It acts on
 * diagnosed gaps only — a held lot with no resting sell, or a fireable rung
 * with no resting buy — never on an empty book, because a ladder resting
 * nothing is not by itself evidence of a fault. Every candidate still crosses
 * the risk manager, so the capital caps, the loss breaker, and the kill switch
 * all still apply, and an order that would be marketable against the last close
 * is refused rather than sent to cross the spread.
 */
export async function placeMissingOrders(): Promise<ActionResult> {
  const result = await post<{
    placed: { candidate: { side: string; limitPrice: number }; quantity: number }[];
    declined: { candidate: { side: string; limitPrice: number }; reason: string }[];
  }>('/orders/place-missing', {});

  revalidatePath('/', 'layout');

  if (!result.ok) {
    const { message, failures } = describe(result.error);
    return { ok: false, message, failures };
  }

  const placed = result.data?.placed ?? [];
  const declined = result.data?.declined ?? [];

  // Declined candidates are surfaced, never swallowed: an operator who pressed
  // this needs to know which gaps remain open.
  const failures = declined.map(
    (d) => `${d.candidate.side} @ ${d.candidate.limitPrice.toFixed(2)} — ${d.reason}`,
  );

  if (placed.length === 0) {
    return {
      ok: false,
      message:
        declined.length === 0
          ? 'No missing orders were found, so nothing was placed.'
          : `Nothing was placed — ${declined.length} candidate(s) refused.`,
      failures: failures.length > 0 ? failures : undefined,
    };
  }

  return {
    ok: true,
    message:
      `Placed ${placed.length} order(s).` +
      (declined.length > 0 ? ` ${declined.length} refused.` : ''),
    failures: failures.length > 0 ? failures : undefined,
  };
}

/**
 * Cancels the redundant order in each unambiguous duplicate group.
 *
 * **The only control that destroys an order**, and it is deliberately narrow:
 * only an *untracked* extra at a price where exactly one order is tied to a
 * rung or lot is cancelled, so the ladder's own claim always survives. A group
 * where no order is tracked, or several are, is reported for an operator to
 * resolve in TWS rather than guessed at. A partially filled order is never
 * eligible.
 */
export async function resolveDuplicateOrders(): Promise<ActionResult> {
  const result = await post<{
    cancelled: { clientOrderId: string; limitPrice: number; side: string }[];
    skipped: { limitPrice: number; side: string; reason: string }[];
    failed: { clientOrderId: string; reason: string }[];
  }>('/orders/resolve-duplicates', {});

  revalidatePath('/', 'layout');

  if (!result.ok) {
    const { message, failures } = describe(result.error);
    return { ok: false, message, failures };
  }

  const cancelled = result.data?.cancelled ?? [];
  const skipped = result.data?.skipped ?? [];
  const failed = result.data?.failed ?? [];

  const notes = [
    ...skipped.map((s) => `@ ${s.limitPrice.toFixed(2)} left alone — ${s.reason}`),
    ...failed.map((f) => `${f.clientOrderId} could not be cancelled — ${f.reason}`),
  ];

  if (cancelled.length === 0) {
    return {
      ok: skipped.length === 0 && failed.length === 0,
      message:
        skipped.length === 0 && failed.length === 0
          ? 'No duplicate orders were found.'
          : 'No order was cancelled.',
      failures: notes.length > 0 ? notes : undefined,
    };
  }

  return {
    ok: failed.length === 0,
    message: `Cancelled ${cancelled.length} duplicate order(s).`,
    failures: notes.length > 0 ? notes : undefined,
  };
}

export async function resetEngine(): Promise<ActionResult> {
  const result = await post('/engine/reset', {});

  revalidatePath('/', 'layout');

  if (!result.ok) {
    const { message } = describe(result.error);
    return { ok: false, message };
  }

  return { ok: true, message: 'Engine reset.' };
}
