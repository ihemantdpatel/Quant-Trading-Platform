import { isRegularSession } from '../../market-data/session';
import { Bar } from '../../market-data/types';
import { DipLadderConfig } from './config';
import { ExitIntent, realizedPnl, selectExit } from './exits';
import { BlockedReason, evaluateBar } from './ladder';
import { closeLot, Lot, openLot } from './lot';
import { createRung, findRung, markHeld, reArm, Rung } from './rung';
import { isSessionOpenBar, sessionDateOf } from './session-window';
import { EntryIntent, LadderPosition } from './types';

/**
 * Drives a bar series through the ladder and accumulates the resulting state.
 *
 * This is a test and SHADOW-inspection harness, not the production engine —
 * Story 6 wires the real one through the coordinator and risk manager. It
 * exists here so the scenario suites can replay a whole fixture and assert on
 * the full cycle: fire → target → exit → re-arm → fire.
 *
 * **Fills are assumed at the intent's limit price.** Story 4 has no broker and
 * no fill model; an entry fills at its rung and an exit at the lot's target, so
 * the ladder can progress and cycles can be counted. Story 6 replaces this with
 * the mock broker's fills and Story 11 adds slippage and commission. Realized
 * P&L reported here is therefore gross and exact — the hand-calculable figure
 * the chop suite asserts against.
 *
 * **Exits are evaluated before entries on each bar.** A bar that closes at or
 * above a lot's target and at or below a lower rung does both, in that order,
 * so freed capital and the re-armed rung are visible to the same bar's entry
 * decision. The re-armed rung itself cannot re-fire until a later bar
 * (`rung.lastExitAt`).
 */

export interface CompletedCycle {
  rungPrice: number;
  lotId: string;
  fillPrice: number;
  exitPrice: number;
  quantity: number;
  openedAt: string;
  closedAt: string;
  /** Gross realized profit. Always positive — lots only exit in profit. */
  realized: number;
}

export interface LadderReplayResult {
  entries: EntryIntent[];
  exits: ExitIntent[];
  /** Every lot ever opened, held and closed. */
  lots: Lot[];
  /** Final rung ledger, including re-armed empty rungs. */
  rungs: Rung[];
  position: LadderPosition;
  completedCycles: CompletedCycle[];
  /** Total gross realized P&L across every completed cycle. */
  totalRealized: number;
  blocked: { timestamp: string; reason: BlockedReason }[];
}

/**
 * Tracks previous-session close and current-session open across the series.
 *
 * Both are read from *regular-session* bars only. Pre- and post-market bars are
 * excluded entirely (`PRD.md:100`), so an after-hours print must not become the
 * close the next session's anchor is measured against.
 *
 * `previousSessionClose` is deliberately distinct from `runningClose`. The
 * bootstrap anchor is `max(previous *session* close, today's open)` and is
 * therefore **fixed for the whole session** — recomputed each session, not each
 * bar (`PRD.md:63`). Feeding it the previous *bar's* close instead would let
 * the anchor track price downward intraday, holding the rung a permanent 5%
 * below spot so it could never be reached.
 */
interface SessionTracker {
  previousSessionClose: number | null;
  runningClose: number | null;
  sessionOpen: number | null;
  sessionDate: string | null;
}

export function replayLadder(bars: Bar[], config: DipLadderConfig): LadderReplayResult {
  const entries: EntryIntent[] = [];
  const exits: ExitIntent[] = [];
  const blocked: LadderReplayResult['blocked'] = [];
  const completedCycles: CompletedCycle[] = [];

  const lots: Lot[] = [];
  let rungs: Rung[] = [];
  let firstEntryPrice: number | null = null;
  let lotSequence = 0;

  const tracker: SessionTracker = {
    previousSessionClose: null,
    runningClose: null,
    sessionOpen: null,
    sessionDate: null,
  };

  /** The entry path's view of current state, rebuilt per evaluation. */
  const positionView = (): LadderPosition => ({
    rungs,
    heldLots: lots.filter((lot) => lot.status === 'HELD'),
    firstEntryPrice,
  });

  for (const bar of bars) {
    if (!isRegularSession(bar.timestamp)) {
      continue;
    }

    const date = sessionDateOf(bar.timestamp);

    if (date !== tracker.sessionDate) {
      // Session boundary: promote the last close seen in the prior session and
      // freeze it for the whole of this one.
      tracker.previousSessionClose = tracker.runningClose;
      tracker.sessionDate = date;
      tracker.sessionOpen = null;
    }

    if (tracker.sessionOpen === null) {
      tracker.sessionOpen = bar.open;
    }

    if (isSessionOpenBar(bar.timestamp)) {
      tracker.sessionOpen = bar.open;
    }

    // ---- Exits first, so this bar's entry sees the freed rung ----
    const exit = selectExit(lots, bar.close, bar.timestamp, config.symbol);

    if (exit) {
      exits.push(exit);

      const index = lots.findIndex((lot) => lot.id === exit.lotId);
      const closed = closeLot(lots[index], exit.limitPrice, bar.timestamp);
      lots[index] = closed;

      rungs = rungs.map((rung) => (rung.lotId === closed.id ? reArm(rung, bar.timestamp) : rung));

      completedCycles.push({
        rungPrice: closed.rungPrice,
        lotId: closed.id,
        fillPrice: closed.fillPrice,
        exitPrice: exit.limitPrice,
        quantity: closed.quantity,
        openedAt: closed.openedAt,
        closedAt: bar.timestamp,
        realized: realizedPnl(closed, exit.limitPrice),
      });
    }

    // ---- Then the entry decision ----
    const decision = evaluateBar(
      bar,
      positionView(),
      config,
      tracker.previousSessionClose,
      tracker.sessionOpen,
      [],
    );

    if (decision.intent) {
      entries.push(decision.intent);

      lotSequence += 1;
      const lot = openLot({
        id: `lot-${lotSequence}`,
        rungPrice: decision.intent.limitPrice,
        // Assumed fill at the rung — see the file comment.
        fillPrice: decision.intent.limitPrice,
        quantity: decision.intent.quantity,
        openedAt: bar.timestamp,
        takeProfitPercent: config.takeProfitPercent,
      });
      lots.push(lot);

      const existing = findRung(rungs, lot.rungPrice);

      if (existing) {
        rungs = rungs.map((rung) =>
          rung.price === existing.price ? markHeld(rung, lot.id) : rung,
        );
      } else {
        rungs.push(markHeld(createRung(lot.rungPrice), lot.id));
      }

      if (firstEntryPrice === null) {
        firstEntryPrice = lot.fillPrice;
      }
    } else if (decision.blocked) {
      blocked.push({ timestamp: bar.timestamp, reason: decision.blocked });
    }

    tracker.runningClose = bar.close;
  }

  return {
    entries,
    exits,
    lots,
    rungs,
    position: positionView(),
    completedCycles,
    totalRealized: roundToCents(completedCycles.reduce((sum, c) => sum + c.realized, 0)),
    blocked,
  };
}

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}
