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
import { post } from './lib/api';

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
  parameters: Record<string, number | string>,
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

export async function resetEngine(): Promise<ActionResult> {
  const result = await post('/engine/reset', {});

  revalidatePath('/', 'layout');

  if (!result.ok) {
    const { message } = describe(result.error);
    return { ok: false, message };
  }

  return { ok: true, message: 'Engine reset.' };
}
