import { NullSentimentProvider } from './null-sentiment.provider';
import { SentimentProvider, SentimentScore } from './sentiment.provider';

describe('NullSentimentProvider', () => {
  const provider: SentimentProvider = new NullSentimentProvider();

  it('returns a neutral reading', () => {
    const reading = provider.read('TQQQ');

    expect(reading).not.toBeNull();
    expect(reading!.score).toBe(SentimentScore.NEUTRAL);
    expect(reading!.symbol).toBe('TQQQ');
    expect(reading!.source).toBe('null');
  });

  it('reports zero confidence — it knows nothing and should carry no weight', () => {
    expect(provider.read('TQQQ')!.confidence).toBe(0);
  });

  it('never vetoes, for any symbol', () => {
    // Absent data must not halt a strategy, or an unconfigured provider would
    // silently stop all trading while looking like a working install.
    for (const symbol of ['TQQQ', 'SPY', 'QQQ', '', 'UNKNOWN']) {
      expect(provider.vetoes(symbol)).toBe(false);
    }
  });

  it('is named so the audit trail records which provider answered', () => {
    expect(provider.name).toBe('null');
  });

  it('is a veto filter, not an entry trigger — the interface exposes no signal method', () => {
    // The asymmetry is the recorded decision (`PRD.md:196`): sentiment can
    // suppress a trade but can never cause one. Asserted structurally so adding
    // a `shouldEnter()` to the interface breaks this test.
    const surface = new Set([
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(provider)),
      ...Object.keys(provider),
    ]);

    expect(surface).toContain('vetoes');
    expect(surface).toContain('read');
    expect(surface).not.toContain('shouldEnter');
    expect(surface).not.toContain('generateIntents');
    expect(surface).not.toContain('signal');
  });
});
