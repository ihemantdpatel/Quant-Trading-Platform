import { ReplayService } from '../market-data/mock/replay.service';
import { checkInvariants } from '../market-data/mock/fixtures/invariants';
import { Bar } from '../market-data/types';
import { parseReplayArgs, REPLAY_USAGE } from './replay-args';

/**
 * `npm run replay -- --fixture chop-range`
 *
 * Prints a fixture's bar stream. Output is deterministic: the same fixture
 * always produces byte-identical stdout, which is the story's exit criterion.
 */

function formatBar(bar: Bar): string {
  return [
    bar.timestamp.padEnd(30),
    bar.open.toFixed(2).padStart(8),
    bar.high.toFixed(2).padStart(8),
    bar.low.toFixed(2).padStart(8),
    bar.close.toFixed(2).padStart(8),
    String(bar.volume).padStart(10),
  ].join(' ');
}

export function runReplay(argv: string[], out: NodeJS.WritableStream = process.stdout): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    out.write(`${REPLAY_USAGE}\n`);
    return 0;
  }

  let args: ReturnType<typeof parseReplayArgs>;
  try {
    args = parseReplayArgs(argv);
  } catch (error) {
    out.write(`${(error as Error).message}\n`);
    return 1;
  }

  const service = new ReplayService();

  let fixture;
  try {
    fixture = service.getFixture(args.fixture);
  } catch (error) {
    out.write(`${(error as Error).message}\n`);
    return 1;
  }

  if (args.describe) {
    out.write(`${fixture.name} (${fixture.symbol}, ${fixture.barSize})\n\n`);
    out.write(`${fixture.expectation}\n\n`);
    out.write('Invariants:\n');
    for (const result of checkInvariants(fixture)) {
      out.write(`  ${result.passed ? '✓' : '✗'} ${result.invariant.kind}: ${result.detail}\n`);
    }
    return 0;
  }

  const bars = args.limit ? fixture.bars.slice(0, args.limit) : fixture.bars;

  if (args.json) {
    for (const bar of bars) {
      out.write(`${JSON.stringify(bar)}\n`);
    }
    return 0;
  }

  out.write(
    `${'timestamp'.padEnd(30)} ${'open'.padStart(8)} ${'high'.padStart(8)} ` +
      `${'low'.padStart(8)} ${'close'.padStart(8)} ${'volume'.padStart(10)}\n`,
  );
  for (const bar of bars) {
    out.write(`${formatBar(bar)}\n`);
  }
  out.write(`\n${bars.length} bars — ${fixture.name}\n`);

  return 0;
}

// Only self-executes as a CLI, so the spec can import runReplay directly.
if (require.main === module) {
  process.exitCode = runReplay(process.argv.slice(2));
}
