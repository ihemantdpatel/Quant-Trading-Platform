import { isSessionOpenBar, isWithinFiringWindow, sessionDateOf } from './session-window';

describe('session window', () => {
  describe('isWithinFiringWindow', () => {
    /**
     * `stories.md` names 09:44 as the must-not-fire case. 09:44 is not a
     * 5-minute boundary, so the bar covering it is the one *opening* at 09:40
     * (09:40:00–09:44:59) — the same point the `session-edges` fixture records.
     * That bar is asserted here, along with the literal 09:44 instant.
     */
    it.each([
      ['2025-01-02T09:30:00.000-05:00', false, 'session open — anchors but does not fire'],
      ['2025-01-02T09:40:00.000-05:00', false, 'bar covering 09:44'],
      ['2025-01-02T09:44:00.000-05:00', false, 'the 09:44 instant itself'],
      ['2025-01-02T09:45:00.000-05:00', true, 'first eligible bar'],
      ['2025-01-02T12:00:00.000-05:00', true, 'midday'],
      ['2025-01-02T15:55:00.000-05:00', true, 'last regular bar'],
      ['2025-01-02T16:00:00.000-05:00', false, 'closing bell — post-market'],
      ['2025-01-02T08:00:00.000-05:00', false, 'pre-market'],
      ['2025-01-02T17:00:00.000-05:00', false, 'post-market'],
    ])('%s → %s (%s)', (timestamp, expected) => {
      expect(isWithinFiringWindow(timestamp)).toBe(expected);
    });

    /**
     * The window is wall-clock ET, so it must not drift with the UTC offset.
     * A fixed-offset shortcut would shift these by an hour twice a year.
     */
    it('holds across the spring-forward transition', () => {
      // EST before, EDT after — 09:45 ET either way.
      expect(isWithinFiringWindow('2025-03-07T09:45:00.000-05:00')).toBe(true);
      expect(isWithinFiringWindow('2025-03-10T09:45:00.000-04:00')).toBe(true);
      expect(isWithinFiringWindow('2025-03-10T09:40:00.000-04:00')).toBe(false);
    });

    it('holds across the fall-back transition', () => {
      expect(isWithinFiringWindow('2025-10-31T09:45:00.000-04:00')).toBe(true);
      expect(isWithinFiringWindow('2025-11-03T09:45:00.000-05:00')).toBe(true);
      expect(isWithinFiringWindow('2025-11-03T16:00:00.000-05:00')).toBe(false);
    });

    it('evaluates a UTC-stamped instant in ET', () => {
      // 14:45Z is 09:45 EST — eligible despite carrying no ET offset.
      expect(isWithinFiringWindow('2025-01-02T14:45:00.000Z')).toBe(true);
      // 14:40Z is 09:40 EST — not eligible.
      expect(isWithinFiringWindow('2025-01-02T14:40:00.000Z')).toBe(false);
    });
  });

  describe('isSessionOpenBar', () => {
    it('identifies the 09:30 bar the bootstrap anchor reads', () => {
      expect(isSessionOpenBar('2025-01-02T09:30:00.000-05:00')).toBe(true);
      expect(isSessionOpenBar('2025-01-02T09:35:00.000-05:00')).toBe(false);
      expect(isSessionOpenBar('2025-01-02T08:00:00.000-05:00')).toBe(false);
    });

    it('is true for a bar that anchors but may not fire', () => {
      // The two rules are deliberately independent: 09:30 anchors, never fires.
      const openBar = '2025-01-02T09:30:00.000-05:00';

      expect(isSessionOpenBar(openBar)).toBe(true);
      expect(isWithinFiringWindow(openBar)).toBe(false);
    });
  });

  describe('sessionDateOf', () => {
    it('returns the ET calendar date', () => {
      expect(sessionDateOf('2025-01-02T09:45:00.000-05:00')).toBe('2025-01-02');
    });

    it('resolves a UTC instant to its ET session date', () => {
      // 01:00Z on the 3rd is 20:00 ET on the 2nd — still the 2nd's session.
      expect(sessionDateOf('2025-01-03T01:00:00.000Z')).toBe('2025-01-02');
    });
  });
});
