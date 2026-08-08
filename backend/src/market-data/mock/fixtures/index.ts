import { Fixture } from '../../types';
import chopRange from './chop-range.json';
import gapDownOpen from './gap-down-open.json';
import gapDownRecover from './gap-down-recover.json';
import sessionEdges from './session-edges.json';
import steadyDecline from './steady-decline.json';

/**
 * The committed fixtures, loaded as static imports.
 *
 * Imported rather than read from disk at runtime so they are bundled into the
 * build and cannot go missing in the container, and so a malformed fixture is
 * a compile-time failure rather than a runtime one.
 */
export const FIXTURE_NAMES = [
  'gap-down-open',
  'gap-down-recover',
  'steady-decline',
  'chop-range',
  'session-edges',
] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];

const FIXTURES: Record<FixtureName, Fixture> = {
  'gap-down-open': gapDownOpen as Fixture,
  'gap-down-recover': gapDownRecover as Fixture,
  'steady-decline': steadyDecline as Fixture,
  'chop-range': chopRange as Fixture,
  'session-edges': sessionEdges as Fixture,
};

export function isFixtureName(name: string): name is FixtureName {
  return (FIXTURE_NAMES as readonly string[]).includes(name);
}

/** Throws with the valid names listed, so a CLI typo is self-correcting. */
export function loadFixture(name: string): Fixture {
  if (!isFixtureName(name)) {
    throw new Error(`Unknown fixture "${name}". Available: ${FIXTURE_NAMES.join(', ')}`);
  }

  return FIXTURES[name];
}

export function allFixtures(): Fixture[] {
  return FIXTURE_NAMES.map((name) => FIXTURES[name]);
}
