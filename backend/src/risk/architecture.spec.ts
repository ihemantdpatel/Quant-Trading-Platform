import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * The architecture test: **no strategy can reach a broker except through the
 * risk manager** (`PRD.md:237`, `stories.md:367`).
 *
 * Asserted over module imports rather than by convention, because convention is
 * exactly what fails silently. A strategy that imports a broker adapter is one
 * `await adapter.submit()` away from bypassing every safety control in this
 * layer, and nothing in a code review reliably catches that on the fifth
 * strategy written eight months from now.
 *
 * The check reads import *specifiers* from source rather than resolving the
 * module graph. Deliberate: a forbidden import is a violation the moment it is
 * written, even if it is unused, type-only, or behind a branch that never runs.
 * Resolution would also require `src/broker/` to exist, and this rule must be
 * enforceable *before* Story 6 creates it — the test earns its keep by failing
 * the first time someone adds that import, not by starting to work later.
 */

const SRC = resolve(__dirname, '..');

/** Layers a strategy may never import from. */
const FORBIDDEN_FOR_STRATEGIES = [
  { layer: 'broker', why: 'only the risk manager may reach a broker' },
  { layer: 'risk', why: 'strategies emit intents; they must not evaluate their own risk' },
];

function sourceFilesUnder(dir: string): string[] {
  let entries: string[];

  try {
    entries = readdirSync(dir);
  } catch {
    // The directory does not exist yet (e.g. src/broker before Story 6).
    return [];
  }

  return entries.flatMap((entry) => {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      return sourceFilesUnder(full);
    }

    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

/** Every import specifier in a file, from static imports, re-exports, and `import(...)`. */
function importSpecifiers(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const patterns = [
    /(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s[^;]*?from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

/**
 * Resolves a specifier to a path relative to `src/`, or null for a package
 * import. Relative specifiers are resolved against the importing file so that
 * `../../broker/x` is caught exactly like `../broker/x`.
 */
function resolveWithinSrc(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null;
  }

  const absolute = resolve(join(file, '..'), specifier);
  const rel = relative(SRC, absolute);

  return rel.startsWith('..') ? null : rel.split(/[\\/]/).join('/');
}

function importsFrom(file: string): string[] {
  return importSpecifiers(file)
    .map((specifier) => resolveWithinSrc(file, specifier))
    .filter((path): path is string => path !== null);
}

describe('architecture: the risk manager is the only path to the broker', () => {
  const strategyFiles = sourceFilesUnder(join(SRC, 'strategies'));

  it('finds strategy source files to check', () => {
    // Guards against the suite passing vacuously if the layer is ever moved.
    expect(strategyFiles.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN_FOR_STRATEGIES)(
    'no strategy module imports from src/$layer — $why',
    ({ layer }) => {
      const violations = strategyFiles.flatMap((file) =>
        importsFrom(file)
          .filter((target) => target === layer || target.startsWith(`${layer}/`))
          .map((target) => `${relative(SRC, file)} imports ${target}`),
      );

      expect(violations).toEqual([]);
    },
  );

  it('no strategy module names a broker submission call', () => {
    // Belt and braces alongside the import rule: catches a strategy that
    // received a broker through a parameter rather than an import.
    //
    // `contract-test-suite.ts` is excluded because it is test infrastructure,
    // not a strategy: it *names* the forbidden calls in order to trap them,
    // building a context whose `submit` throws so a violating plugin fails its
    // contract test. Scanning it flags the enforcement mechanism as the
    // violation it exists to catch.
    const violations = strategyFiles
      .filter((file) => !file.endsWith('contract-test-suite.ts'))
      .filter((file) =>
        /\.(submit|placeOrder|sendOrder|cancelOrder)\s*\(/.test(readFileSync(file, 'utf8')),
      );

    expect(violations.map((file) => relative(SRC, file))).toEqual([]);
  });

  it('the exclusion above is narrow — the trap file really does name a submission call', () => {
    // Guards the exclusion: if `contract-test-suite.ts` ever stops trapping
    // submission calls, this fails and the exclusion should be removed rather
    // than left silently covering a file that no longer needs it.
    const trap = readFileSync(join(SRC, 'strategies', 'contract-test-suite.ts'), 'utf8');

    expect(/submit/.test(trap)).toBe(true);
  });

  it('the risk layer does not import any individual strategy', () => {
    // The chokepoint sits above every strategy. Depending on one would make it
    // ladder-specific and invert the dependency.
    const violations = sourceFilesUnder(join(SRC, 'risk')).flatMap((file) =>
      importsFrom(file)
        .filter((target) => target.startsWith('strategies/'))
        .map((target) => `${relative(SRC, file)} imports ${target}`),
    );

    expect(violations).toEqual([]);
  });

  /**
   * The rule that matters at Story 6, asserted now so the adapter cannot land
   * without it. Currently vacuous — `src/broker/` does not exist — which is why
   * the detector itself is tested below.
   */
  it('no broker module imports a strategy', () => {
    const violations = sourceFilesUnder(join(SRC, 'broker')).flatMap((file) =>
      importsFrom(file)
        .filter((target) => target.startsWith('strategies/'))
        .map((target) => `${relative(SRC, file)} imports ${target}`),
    );

    expect(violations).toEqual([]);
  });
});

/**
 * Proves the detector above can actually fail. Without this, the architecture
 * suite would pass just as happily against a broken regex — and a safety test
 * that cannot fail is worse than no test, because it reports confidence it has
 * not earned.
 */
describe('architecture: the detector detects', () => {
  const fixture = join(SRC, 'strategies', 'dip-ladder', 'ladder.ts');

  it('extracts relative imports from a real strategy file', () => {
    const imports = importsFrom(fixture);

    expect(imports).toContain('market-data/types');
    expect(imports).toContain('strategies/dip-ladder/anchor');
  });

  it.each([
    ["import { X } from '../../broker/ib/adapter';", 'broker/ib/adapter'],
    ["import '../../broker/adapter';", 'broker/adapter'],
    ["export { X } from '../../broker/adapter';", 'broker/adapter'],
    ["const m = await import('../../broker/adapter');", 'broker/adapter'],
    ["const m = require('../../broker/adapter');", 'broker/adapter'],
  ])('flags a forbidden import written as %s', (statement, expected) => {
    const tmp = join(SRC, 'strategies', 'dip-ladder', '__arch_probe.ts');
    const specifiers = [...statement.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const resolved = specifiers
      .map((specifier) => resolveWithinSrc(tmp, specifier))
      .filter((path): path is string => path !== null);

    expect(resolved).toContain(expected);
  });

  it('ignores package imports', () => {
    expect(resolveWithinSrc(fixture, '@nestjs/common')).toBeNull();
    expect(resolveWithinSrc(fixture, 'luxon')).toBeNull();
  });

  it('ignores paths that escape src/', () => {
    expect(resolveWithinSrc(fixture, '../../../package.json')).toBeNull();
  });
});
