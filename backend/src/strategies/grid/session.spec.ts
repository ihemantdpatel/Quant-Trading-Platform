import { sessionDateOf } from './session';

describe('sessionDateOf', () => {
  it('returns the ET calendar date for a timestamp', () => {
    expect(sessionDateOf('2025-01-02T10:00:00.000-05:00')).toBe('2025-01-02');
  });

  it('is ET, not UTC — a late evening ET bar does not roll to the next UTC day', () => {
    expect(sessionDateOf('2025-01-02T23:30:00.000-05:00')).toBe('2025-01-02');
  });
});
