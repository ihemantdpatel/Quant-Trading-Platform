import { Writable } from 'node:stream';
import { parseReplayArgs } from './replay-args';
import { runReplay } from './replay';

/** Collects everything written, so CLI output can be asserted without a subprocess. */
function capture(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });

  return { stream, text: () => chunks.join('') };
}

describe('parseReplayArgs', () => {
  it('parses --fixture', () => {
    expect(parseReplayArgs(['--fixture', 'chop-range']).fixture).toBe('chop-range');
  });

  it('accepts a bare fixture name as shorthand', () => {
    expect(parseReplayArgs(['chop-range']).fixture).toBe('chop-range');
  });

  it('parses --json, --describe and --limit', () => {
    const args = parseReplayArgs([
      '--fixture',
      'chop-range',
      '--json',
      '--describe',
      '--limit',
      '5',
    ]);

    expect(args).toEqual({ fixture: 'chop-range', json: true, describe: true, limit: 5 });
  });

  it('throws when --fixture is missing', () => {
    expect(() => parseReplayArgs([])).toThrow(/Missing required --fixture/);
  });

  it('lists available fixtures in the error', () => {
    expect(() => parseReplayArgs([])).toThrow(/chop-range/);
  });

  it('rejects a non-positive or non-integer --limit', () => {
    expect(() => parseReplayArgs(['--fixture', 'chop-range', '--limit', '0'])).toThrow(/--limit/);
    expect(() => parseReplayArgs(['--fixture', 'chop-range', '--limit', '-3'])).toThrow(/--limit/);
    expect(() => parseReplayArgs(['--fixture', 'chop-range', '--limit', 'abc'])).toThrow(/--limit/);
    expect(() => parseReplayArgs(['--fixture', 'chop-range', '--limit'])).toThrow(/--limit/);
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    expect(() => parseReplayArgs(['--fixture', 'chop-range', '--nope'])).toThrow(
      /Unknown option "--nope"/,
    );
  });
});

describe('runReplay', () => {
  it('prints a header and the requested number of bars', () => {
    const { stream, text } = capture();

    expect(runReplay(['--fixture', 'chop-range', '--limit', '3'], stream)).toBe(0);

    const lines = text().trimEnd().split('\n');
    expect(lines[0]).toMatch(/timestamp\s+open\s+high\s+low\s+close\s+volume/);
    expect(text()).toMatch(/3 bars — chop-range/);
  });

  it('emits one JSON object per line under --json', () => {
    const { stream, text } = capture();

    runReplay(['--fixture', 'chop-range', '--json', '--limit', '4'], stream);

    const lines = text().trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      const bar = JSON.parse(line);
      expect(bar.symbol).toBe('TQQQ');
      expect(typeof bar.close).toBe('number');
    }
  });

  // The story's exit criterion.
  it('is deterministic — re-running produces identical output', () => {
    const first = capture();
    const second = capture();

    runReplay(['--fixture', 'chop-range', '--json'], first.stream);
    runReplay(['--fixture', 'chop-range', '--json'], second.stream);

    expect(first.text()).toEqual(second.text());
    expect(first.text().length).toBeGreaterThan(0);
  });

  it('describes a fixture with its expectation and invariant results', () => {
    const { stream, text } = capture();

    expect(runReplay(['--fixture', 'steady-decline', '--describe'], stream)).toBe(0);

    expect(text()).toMatch(/steady-decline \(TQQQ, 5min\)/);
    expect(text()).toMatch(/25% hard floor/);
    expect(text()).toMatch(/✓ closesBelowFirstBarByPct/);
  });

  it('exits non-zero with a helpful message for an unknown fixture', () => {
    const { stream, text } = capture();

    expect(runReplay(['--fixture', 'nope'], stream)).toBe(1);
    expect(text()).toMatch(/Unknown fixture "nope"/);
  });

  it('exits non-zero when --fixture is missing', () => {
    const { stream, text } = capture();

    expect(runReplay([], stream)).toBe(1);
    expect(text()).toMatch(/Missing required --fixture/);
  });

  it('prints usage for --help and exits zero', () => {
    const { stream, text } = capture();

    expect(runReplay(['--help'], stream)).toBe(0);
    expect(text()).toMatch(/Usage: npm run replay/);
  });

  it('prints every bar when no limit is given', () => {
    const { stream, text } = capture();

    runReplay(['--fixture', 'session-edges', '--json'], stream);

    expect(text().trimEnd().split('\n')).toHaveLength(164);
  });
});
