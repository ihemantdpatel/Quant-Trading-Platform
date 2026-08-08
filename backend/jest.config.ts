import type { Config } from 'jest';

/**
 * Coverage thresholds per `stories.md` — 80% global, 95% on the strategy and
 * risk layers. Those are pure functions with no I/O, so 95% is cheap there,
 * and they are where a bug costs real money.
 *
 * The glob keys are evaluated against files matched by `collectCoverageFrom`.
 * A path-keyed threshold removes those files from the global bucket, so the
 * 80% global figure applies to everything *except* strategies and risk.
 */
const config: Config = {
  rootDir: 'src',
  testEnvironment: 'node',
  testRegex: '.*\\.spec\\.ts$',
  // The database-backed suites run from `jest.database.config.ts` instead:
  // they share one MySQL schema and must not be spread across parallel
  // workers. Excluding them here keeps this run fully parallel.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/repositories/prisma/'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
  moduleFileExtensions: ['js', 'json', 'ts'],
  collectCoverageFrom: [
    '**/*.ts',
    '!**/*.spec.ts',
    // Bootstrap wiring: calling it in a unit test starts a real HTTP listener.
    // The health integration test covers the module graph it builds.
    '!main.ts',
    '!**/*.module.ts',
    // Build-time authoring script for the fixture JSON, run via
    // `npm run fixtures:build` and never imported at runtime. Its *output* is
    // what ships, and fixtures.spec.ts asserts that output exhaustively —
    // measuring the generator itself would report coverage on code no
    // deployed artifact executes.
    '!market-data/mock/fixtures/definitions.ts',
    // Exercised by `jest.database.config.ts`, which needs a live MySQL. Counted
    // here they would report ~0% in any run without one — punishing the global
    // threshold for code this run deliberately does not execute. `npm run
    // test:cov:db` measures them against a real database.
    '!repositories/prisma/**',
    // The IB socket itself (Story 10), excluded for the same reason as the
    // Prisma layer: it cannot execute without a live IB Gateway, and counting
    // it would punish the global threshold for code this run cannot run.
    //
    // **Only the socket body is excluded, not the conversions.** The pure
    // wire-format translation lives in `ib-wire.ts` precisely so it stays
    // measured — that is where a mis-encoded order payload or a misread
    // timestamp would come from, and `ib-wire.spec.ts` covers it fully. What is
    // excluded here is the `IBApiNext` plumbing around it, which is verified by
    // connecting to a real Gateway (`stories.md:622`).
    '!broker/ib/stoqey-ib-socket.ts',
    // A test double, exercised only *by* tests. Its uncovered branches are
    // simulation seams no production path reaches; measuring it would report
    // coverage on scaffolding rather than on shipped behaviour.
    '!broker/ib/fake-ib-socket.ts',
  ],
  coverageDirectory: '../coverage',
  coverageReporters: ['text', 'lcov', 'json-summary'],
  coverageThreshold: {
    global: {
      lines: 80,
      branches: 80,
      functions: 80,
      statements: 80,
    },
    './src/strategies/**/*.ts': {
      lines: 95,
      branches: 95,
      functions: 95,
      statements: 95,
    },
    './src/risk/**/*.ts': {
      lines: 95,
      branches: 95,
      functions: 95,
      statements: 95,
    },
  },
};

export default config;
