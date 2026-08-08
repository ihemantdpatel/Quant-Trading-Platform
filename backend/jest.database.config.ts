/**
 * Jest config for the **database-backed** suites only.
 *
 * These share a single MySQL schema, so they run in one worker. Jest's parallel
 * workers would otherwise interleave inserts and truncations against the same
 * tables, and a suite would fail on rows another suite wrote — which reads as a
 * repository bug and is not one.
 *
 * Kept as its own config rather than a `maxWorkers` setting on the main one,
 * because that option applies per *run*, not per project: serialising there
 * would also serialise the ~860 tests that never open a connection.
 *
 * `npm test` runs both configs in sequence. Coverage thresholds live in
 * `jest.config.ts` and are evaluated by the combined run in `test:cov`.
 */

import type { Config } from 'jest';

const config: Config = {
  rootDir: 'src',
  displayName: 'database',
  testEnvironment: 'node',
  testRegex: 'repositories/prisma/.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
  moduleFileExtensions: ['js', 'json', 'ts'],
  // The whole point of this file.
  maxWorkers: 1,
  // Only the Prisma layer — the rest of the tree is measured by the main run,
  // and folding both into one report would double-count nothing useful.
  collectCoverageFrom: ['repositories/prisma/**/*.ts', '!**/*.spec.ts', '!**/test-database.ts'],
  // Nested inside `coverage/`, which .gitignore and .prettierignore already
  // cover — a sibling directory would be committed and linted as source.
  coverageDirectory: '../coverage/database',
  coverageReporters: ['text', 'lcov', 'json-summary'],
};

export default config;
