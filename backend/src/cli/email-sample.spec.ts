import { DateTime } from 'luxon';
import { parseEmailSampleArgs, sampleWindow } from './email-sample';

describe('email-sample CLI', () => {
  it('defaults to 7 days, ./email-samples, and sending', () => {
    expect(parseEmailSampleArgs([])).toEqual({ days: 7, out: './email-samples', send: true });
  });

  it('reads --days, --out, and --no-send', () => {
    expect(parseEmailSampleArgs(['--days', '3', '--out', '/tmp/x', '--no-send'])).toEqual({
      days: 3,
      out: '/tmp/x',
      send: false,
    });
  });

  it.each(['0', '-1', '2.5', 'week', '400'])('refuses --days %s', (days) => {
    expect(() => parseEmailSampleArgs(['--days', days])).toThrow(/--days/);
  });

  it('covers the N ET days ending today', () => {
    // 02:00Z on the 28th is still the 27th in ET.
    const now = DateTime.fromISO('2026-09-28T02:00:00Z', { zone: 'utc' });

    expect(sampleWindow(now, 7)).toEqual({ from: '2026-09-21', to: '2026-09-27' });
    expect(sampleWindow(now, 1)).toEqual({ from: '2026-09-27', to: '2026-09-27' });
  });
});
