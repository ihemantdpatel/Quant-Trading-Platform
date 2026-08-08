/**
 * Architecture rules the backtester must satisfy.
 *
 * Story 11's claim is that the backtester is **an implementation behind the
 * existing interfaces, not a parallel engine** (`stories.md:636`). That claim is
 * easy to state and easy to erode: one convenience import of the IB adapter, or
 * one backtest-shaped branch inside the strategy, and the code the backtest
 * validates stops being the code that trades — while every test still passes.
 *
 * These rules are structural, checked over module imports, and they mirror
 * `src/risk/architecture.spec.ts` in both approach and reason. The detector is
 * proved able to fail at the bottom of this file, because a safety check that
 * cannot fail reports confidence it has not earned (`CLAUDE.md`).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = join(__dirname, '..');

function sourceFilesUnder(dir: string): string[] {
  const entries = readdirSync(dir);

  return entries.flatMap((entry) => {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      return sourceFilesUnder(full);
    }

    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

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

function resolveWithinSrc(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null;
  }

  const rel = relative(SRC, resolve(join(file, '..'), specifier));

  return rel.startsWith('..') ? null : rel.split(/[\\/]/).join('/');
}

function importsFrom(file: string): string[] {
  return importSpecifiers(file)
    .map((specifier) => resolveWithinSrc(file, specifier))
    .filter((path): path is string => path !== null);
}

describe('architecture: the backtester is an implementation, not a parallel engine', () => {
  const backtestFiles = sourceFilesUnder(join(SRC, 'backtest'));

  it('finds backtest source files to check', () => {
    // Guards against this whole suite passing vacuously if the layer moves.
    expect(backtestFiles.length).toBeGreaterThan(0);
  });

  it('never imports the IB adapter — a backtest cannot reach a real broker', () => {
    // The property that makes `POST /backtest` safe in any execution mode.
    const violations = backtestFiles.flatMap((file) =>
      importsFrom(file)
        .filter((target) => target.startsWith('broker/ib'))
        .map((target) => `${relative(SRC, file)} imports ${target}`),
    );

    expect(violations).toEqual([]);
  });

  it('never imports the live feed or the backfill — history comes from the cache', () => {
    // A sweep that fetched its own history would issue hundreds of identical
    // requests and breach IB's pacing limits, which fail silently rather than
    // cleanly (`PRD.md:289`).
    const violations = backtestFiles.flatMap((file) =>
      importsFrom(file)
        .filter(
          (target) =>
            target.startsWith('market-data/live') ||
            target.startsWith('market-data/history/backfill'),
        )
        .map((target) => `${relative(SRC, file)} imports ${target}`),
    );

    expect(violations).toEqual([]);
  });

  it('uses the real strategy and risk modules rather than reimplementing them', () => {
    // The positive form of the claim: the harness must actually depend on the
    // production strategy and risk code. A backtester that imported neither
    // would be the parallel engine this story forbids.
    const harness = join(SRC, 'backtest', 'replay-harness.ts');
    const imports = importsFrom(harness);

    expect(imports).toContain('strategies/dip-ladder/dip-ladder.strategy');
    expect(imports).toContain('risk/risk-manager.service');
    expect(imports).toContain('engine/engine.service');
    expect(imports).toContain('strategies/coordinator.service');
  });

  it('no strategy or risk module imports the backtester — the dependency points one way', () => {
    // If the strategy knew about the backtester it could behave differently
    // under test, and every result would be evidence about a different system.
    const files = [
      ...sourceFilesUnder(join(SRC, 'strategies')),
      ...sourceFilesUnder(join(SRC, 'risk')),
    ];

    const violations = files.flatMap((file) =>
      importsFrom(file)
        .filter((target) => target.startsWith('backtest'))
        .map((target) => `${relative(SRC, file)} imports ${target}`),
    );

    expect(violations).toEqual([]);
  });

  it('the engine does not import the backtester', () => {
    // `EngineService` must have no backtest-shaped branch. The module wires the
    // controller, which is a different file and a legitimate composition point.
    const engineService = join(SRC, 'engine', 'engine.service.ts');

    expect(importsFrom(engineService).filter((t) => t.startsWith('backtest'))).toEqual([]);
  });

  it('the simulated broker imports no strategy', () => {
    // Same rule every adapter obeys: a broker reports a net position and knows
    // nothing of lot composition (`broker-adapter.interface.ts`).
    const violations = sourceFilesUnder(join(SRC, 'broker', 'simulated')).flatMap((file) =>
      importsFrom(file)
        .filter((target) => target.startsWith('strategies/'))
        .map((target) => `${relative(SRC, file)} imports ${target}`),
    );

    expect(violations).toEqual([]);
  });

  it('the simulated broker implements the shared interface', () => {
    const adapter = join(SRC, 'broker', 'simulated', 'simulated-broker.adapter.ts');

    expect(importsFrom(adapter)).toContain('broker/broker-adapter.interface');
  });
});

/**
 * Proves the detector can fail, exactly as `risk/architecture.spec.ts` does for
 * its own. Without this the rules above would pass just as happily against a
 * broken regex.
 */
describe('architecture: the detector detects', () => {
  const fixture = join(SRC, 'backtest', 'replay-harness.ts');

  it('extracts relative imports from a real backtest file', () => {
    expect(importsFrom(fixture).length).toBeGreaterThan(0);
  });

  it.each([
    ["import { X } from '../broker/ib/ib-broker.adapter';", 'broker/ib/ib-broker.adapter'],
    ["import '../broker/ib/ib-broker.adapter';", 'broker/ib/ib-broker.adapter'],
    ["export { X } from '../broker/ib/ib-broker.adapter';", 'broker/ib/ib-broker.adapter'],
    [
      "const m = await import('../market-data/live/live-feed.service');",
      'market-data/live/live-feed.service',
    ],
  ])('flags a forbidden import written as %s', (line, expected) => {
    const specifiers = [...line.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const resolved = specifiers
      .map((s) => resolveWithinSrc(join(SRC, 'backtest', 'probe.ts'), s))
      .filter((p): p is string => p !== null);

    expect(resolved).toContain(expected);
  });

  it('ignores package imports', () => {
    expect(resolveWithinSrc(fixture, '@nestjs/common')).toBeNull();
  });

  it('ignores paths that escape src/', () => {
    expect(resolveWithinSrc(fixture, '../../../elsewhere')).toBeNull();
  });
});
