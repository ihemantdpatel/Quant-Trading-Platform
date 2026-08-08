import { FIXTURE_NAMES } from '../market-data/mock/fixtures';

export interface ReplayArgs {
  fixture: string;
  /** Emit one JSON object per line instead of the aligned table. */
  json: boolean;
  /** Print the fixture's documented expectation and invariants, then exit. */
  describe: boolean;
  limit?: number;
}

export const REPLAY_USAGE = `Usage: npm run replay -- --fixture <name> [options]

Options:
  --fixture <name>   Fixture to replay (required)
  --limit <n>        Print only the first n bars
  --json             One JSON object per line
  --describe         Print the fixture's expectation and invariants, then exit
  --help             Show this message

Fixtures: ${FIXTURE_NAMES.join(', ')}`;

/**
 * Parses argv into typed options. Kept free of I/O so the CLI's argument
 * handling is unit-testable without spawning a process.
 */
export function parseReplayArgs(argv: string[]): ReplayArgs {
  let fixture = '';
  let json = false;
  let describe = false;
  let limit: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    switch (arg) {
      case '--fixture':
        fixture = argv[i + 1] ?? '';
        i += 1;
        break;
      case '--limit': {
        const raw = argv[i + 1];
        const parsed = Number(raw);
        if (!raw || !Number.isInteger(parsed) || parsed <= 0) {
          throw new Error(`--limit expects a positive integer, got "${raw ?? ''}"`);
        }
        limit = parsed;
        i += 1;
        break;
      }
      case '--json':
        json = true;
        break;
      case '--describe':
        describe = true;
        break;
      default:
        // A bare fixture name is accepted as shorthand; anything else that
        // looks like a flag is a typo worth reporting rather than ignoring.
        if (arg.startsWith('--')) {
          throw new Error(`Unknown option "${arg}"\n\n${REPLAY_USAGE}`);
        }
        if (!fixture) {
          fixture = arg;
        }
    }
  }

  if (!fixture) {
    throw new Error(`Missing required --fixture\n\n${REPLAY_USAGE}`);
  }

  return { fixture, json, describe, limit };
}
