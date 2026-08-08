import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAllFixtures } from '../src/market-data/mock/fixtures/definitions';
import { assertInvariants } from '../src/market-data/mock/fixtures/invariants';

/**
 * Regenerates the committed fixture JSON.
 *
 * The committed files are the source of truth, not this script — run it, review
 * the diff, commit deliberately. Output is validated before writing so a broken
 * scenario can never reach disk.
 */
const OUT_DIR = join(__dirname, '..', 'src', 'market-data', 'mock', 'fixtures');

function main(): void {
  const fixtures = buildAllFixtures();

  for (const fixture of fixtures) {
    assertInvariants(fixture);

    const path = join(OUT_DIR, `${fixture.name}.json`);
    writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');

    process.stdout.write(`✓ ${fixture.name.padEnd(20)} ${fixture.bars.length} bars\n`);
  }

  process.stdout.write(`\nWrote ${fixtures.length} fixtures to ${OUT_DIR}\n`);
}

main();
