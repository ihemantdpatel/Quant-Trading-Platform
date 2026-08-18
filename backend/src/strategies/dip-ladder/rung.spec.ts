import {
  clearWorking,
  createRung,
  findRung,
  heldRungs,
  highestFireableRung,
  isFireable,
  isHeldRung,
  isWorkingRung,
  lowestRungPrice,
  markHeld,
  markWorking,
  reArm,
  Rung,
  RungStatus,
  selectFireableRung,
} from './rung';

const EXIT_BAR = '2025-01-03T11:00:00.000-05:00';
const BAR = '2025-01-06T10:00:00.000-05:00';

describe('createRung', () => {
  it('starts PENDING and empty', () => {
    const rung = createRung(95);

    expect(rung).toEqual({
      price: 95,
      status: RungStatus.PENDING,
      lotId: null,
      workingOrderId: null,
      completedCycles: 0,
      lastExitAt: null,
    });
  });

  it('rounds the price to cents', () => {
    expect(createRung(90.2500001).price).toBe(90.25);
  });

  it('round-trips through JSON — rungs are durable state', () => {
    const rung = createRung(95);

    expect(JSON.parse(JSON.stringify(rung))).toEqual(rung);
  });
});

describe('markHeld', () => {
  it('records the lot and marks the rung HELD', () => {
    const held = markHeld(createRung(95), 'lot-1');

    expect(held.status).toBe(RungStatus.HELD);
    expect(held.lotId).toBe('lot-1');
  });

  it('does not mutate the original', () => {
    const rung = createRung(95);
    markHeld(rung, 'lot-1');

    expect(rung.status).toBe(RungStatus.PENDING);
    expect(rung.lotId).toBeNull();
  });
});

/**
 * A rung is re-armed **at its original price**, not at the exit price
 * (`PRD.md:78`). Re-arming at the exit price would walk the ladder's levels
 * upward every cycle, so a range oscillating around a fixed band would drift
 * out of it and stop cycling — losing exactly the behaviour per-lot exits exist
 * to produce.
 */
describe('reArm', () => {
  const held = markHeld(createRung(95), 'lot-1');
  const rearmed = reArm(held, EXIT_BAR);

  it('preserves the original price', () => {
    expect(rearmed.price).toBe(95);
  });

  it('clears the lot and marks the rung RE_ARMED', () => {
    expect(rearmed.status).toBe(RungStatus.RE_ARMED);
    expect(rearmed.lotId).toBeNull();
  });

  it('increments the completed cycle count', () => {
    expect(rearmed.completedCycles).toBe(1);
    expect(reArm(markHeld(rearmed, 'lot-2'), EXIT_BAR).completedCycles).toBe(2);
  });

  it('records the exit bar as the same-bar re-fire guard', () => {
    expect(rearmed.lastExitAt).toBe(EXIT_BAR);
  });

  it('does not mutate the original', () => {
    expect(held.status).toBe(RungStatus.HELD);
    expect(held.completedCycles).toBe(0);
  });
});

describe('isHeldRung / isFireable', () => {
  const pending = createRung(95);
  const held = markHeld(pending, 'lot-1');
  const rearmed = reArm(held, EXIT_BAR);

  it('treats only HELD rungs as held', () => {
    expect(isHeldRung(held)).toBe(true);
    expect(isHeldRung(pending)).toBe(false);
    expect(isHeldRung(rearmed)).toBe(false);
  });

  /**
   * A re-armed rung is exactly as fireable as one that has never fired. That
   * equivalence is what makes the ladder cycle.
   */
  it('treats both PENDING and RE_ARMED as fireable', () => {
    expect(isFireable(pending)).toBe(true);
    expect(isFireable(rearmed)).toBe(true);
    expect(isFireable(held)).toBe(false);
  });
});

/**
 * The 5-concurrent limit counts rungs *holding a lot* (`PRD.md:163`).
 * Re-armed empty rungs stay in the ledger and must not consume a slot.
 */
describe('heldRungs', () => {
  it('counts held rungs only, excluding re-armed and pending', () => {
    const rungs: Rung[] = [
      markHeld(createRung(95), 'lot-1'),
      reArm(markHeld(createRung(90.25), 'lot-2'), EXIT_BAR),
      createRung(85.74),
      markHeld(createRung(81.45), 'lot-3'),
    ];

    expect(heldRungs(rungs).map((r) => r.price)).toEqual([95, 81.45]);
  });

  it('is empty when nothing is held', () => {
    expect(heldRungs([createRung(95)])).toEqual([]);
  });
});

describe('lowestRungPrice', () => {
  it('returns the deepest level in the ledger', () => {
    expect(lowestRungPrice([createRung(95), createRung(85.74), createRung(90.25)])).toBe(85.74);
  });

  it('includes re-armed rungs — they are still established levels', () => {
    const rungs = [createRung(95), reArm(markHeld(createRung(85.74), 'lot-1'), EXIT_BAR)];

    expect(lowestRungPrice(rungs)).toBe(85.74);
  });

  it('returns null for an empty ledger', () => {
    expect(lowestRungPrice([])).toBeNull();
  });
});

describe('findRung', () => {
  const rungs = [createRung(95), createRung(90.25)];

  it('finds a rung by price', () => {
    expect(findRung(rungs, 90.25)!.price).toBe(90.25);
  });

  it('matches at cent precision despite float noise', () => {
    expect(findRung(rungs, 95 - 4.75000000001)!.price).toBe(90.25);
  });

  it('returns null for a level the ladder does not have', () => {
    expect(findRung(rungs, 85.74)).toBeNull();
  });
});

describe('selectFireableRung', () => {
  const rungs: Rung[] = [
    markHeld(createRung(95), 'lot-1'),
    reArm(markHeld(createRung(90.25), 'lot-2'), EXIT_BAR),
    createRung(85.74),
  ];

  it('fires a re-armed rung the close has reached', () => {
    expect(selectFireableRung(rungs, 90, BAR)!.price).toBe(90.25);
  });

  it('never fires a rung that holds a lot', () => {
    // Close is below 95.00, but that rung is held — the 90.25 rung wins.
    expect(selectFireableRung(rungs, 90, BAR)!.price).not.toBe(95);
  });

  /**
   * The shallowest reachable rung fires first, so a bar that gaps through
   * several levels descends one rung per bar rather than opening the whole
   * ladder on a single fast move. Depth should reflect sustained weakness.
   */
  it('picks the highest fireable rung when a bar reaches several', () => {
    expect(selectFireableRung(rungs, 80, BAR)!.price).toBe(90.25);
  });

  it('is independent of ledger order', () => {
    // Same rungs, reversed — the reduce must not depend on which candidate it
    // sees first.
    expect(selectFireableRung([...rungs].reverse(), 80, BAR)!.price).toBe(90.25);
  });

  it('picks the single candidate when only one is reachable', () => {
    // 90.10 is below the 90.25 rung but above 85.74, so 90.25 is the only
    // fireable rung the close has reached.
    expect(selectFireableRung(rungs, 90.1, BAR)!.price).toBe(90.25);
  });

  it('returns null when the close is above every fireable rung', () => {
    expect(selectFireableRung(rungs, 99, BAR)).toBeNull();
  });

  it('returns null for an empty ledger', () => {
    expect(selectFireableRung([], 90, BAR)).toBeNull();
  });

  /**
   * A rung that exited on this bar may not re-fire until a later one. A round
   * trip inside a single 5-minute bar is not something real fills would
   * reliably achieve, and allowing it would inflate cycle counts with trades
   * that never happened.
   */
  it('does not re-fire a rung that exited on this same bar', () => {
    const justExited = [reArm(markHeld(createRung(95), 'lot-1'), BAR)];

    expect(selectFireableRung(justExited, 90, BAR)).toBeNull();
  });

  it('allows that rung to fire on a later bar', () => {
    const justExited = [reArm(markHeld(createRung(95), 'lot-1'), EXIT_BAR)];

    expect(selectFireableRung(justExited, 90, BAR)!.price).toBe(95);
  });
});

describe('resting orders on a rung', () => {
  it('marks a rung WORKING without giving it a lot', () => {
    // The state that did not exist before: occupied, but holding nothing. A
    // fill is what turns it into a lot.
    const working = markWorking(createRung(95), 'co-1');

    expect(working.status).toBe(RungStatus.WORKING);
    expect(working.workingOrderId).toBe('co-1');
    expect(working.lotId).toBeNull();
    expect(isWorkingRung(working)).toBe(true);
  });

  it('is not fireable while an order rests there', () => {
    // The duplicate-order guard. `lotId` is null, so any test based on that
    // alone would place a second order at this price on the next bar.
    const working = markWorking(createRung(95), 'co-1');

    expect(working.lotId).toBeNull();
    expect(isFireable(working)).toBe(false);
  });

  it('clears back to PENDING when the order never filled', () => {
    const released = clearWorking(markWorking(createRung(95), 'co-1'));

    expect(released.status).toBe(RungStatus.PENDING);
    expect(released.workingOrderId).toBeNull();
    expect(isFireable(released)).toBe(true);
  });

  it('clears back to RE_ARMED when the rung had already cycled', () => {
    // Preserves the distinction `completedCycles` records: a rung that has
    // traded before is re-armed, not pending, even after a failed order.
    const cycled = reArm(markHeld(createRung(95), 'lot-1'), EXIT_BAR);
    const released = clearWorking(markWorking(cycled, 'co-2'));

    expect(released.status).toBe(RungStatus.RE_ARMED);
    expect(released.completedCycles).toBe(1);
    expect(isFireable(released)).toBe(true);
  });

  it('drops the resting order id once the order fills', () => {
    // A stale id would let a later cancel target an order the broker already
    // completed.
    const filled = markHeld(markWorking(createRung(95), 'co-1'), 'lot-1');

    expect(filled.status).toBe(RungStatus.HELD);
    expect(filled.workingOrderId).toBeNull();
    expect(filled.lotId).toBe('lot-1');
  });

  it('excludes a working rung from selection even when price reached it', () => {
    const working = [markWorking(createRung(95), 'co-1')];

    expect(selectFireableRung(working, 90, BAR)).toBeNull();
  });
});

describe('highestFireableRung', () => {
  it('ignores price entirely', () => {
    // The resting-order counterpart to `selectFireableRung`: an order is placed
    // *above* the market and waits, so requiring the bar to have reached the
    // level first would defeat the point.
    const rungs = [createRung(95), createRung(90.25)];

    expect(highestFireableRung(rungs, BAR)!.price).toBe(95);
  });

  it('skips rungs that already have an order resting', () => {
    const rungs = [markWorking(createRung(95), 'co-1'), createRung(90.25)];

    expect(highestFireableRung(rungs, BAR)!.price).toBe(90.25);
  });

  it('skips held rungs', () => {
    const rungs = [markHeld(createRung(95), 'lot-1'), createRung(90.25)];

    expect(highestFireableRung(rungs, BAR)!.price).toBe(90.25);
  });

  it('honours the same-bar re-fire guard', () => {
    const rungs = [reArm(markHeld(createRung(95), 'lot-1'), BAR)];

    expect(highestFireableRung(rungs, BAR)).toBeNull();
  });

  it('returns null when every rung is occupied', () => {
    const rungs = [markWorking(createRung(95), 'co-1'), markHeld(createRung(90.25), 'lot-1')];

    expect(highestFireableRung(rungs, BAR)).toBeNull();
  });
});
