/**
 * Component tests for the dashboard (`stories.md:463`).
 *
 * Uses `next/jest`, which wires the project's SWC transform, path aliases, and
 * CSS module stubs — so the tests compile components exactly as Next does
 * rather than through a second, subtly different TypeScript setup.
 *
 * Scope is deliberately the presentational components. The Server Components
 * and Server Actions that fetch and mutate are covered by the backend's own
 * integration suite over the real HTTP API, which is the same contract the UI
 * calls; duplicating that here with a mocked `fetch` would assert against a
 * fixture of the API rather than the API.
 */
import nextJest from 'next/jest.js';

const createJestConfig = nextJest({ dir: './' });

/** @type {import('jest').Config} */
const config = {
  testEnvironment: 'jest-environment-jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  testMatch: ['<rootDir>/app/**/*.test.tsx', '<rootDir>/app/**/*.test.ts'],
  collectCoverageFrom: ['app/**/*.{ts,tsx}', '!app/**/*.test.{ts,tsx}', '!app/**/layout.tsx'],
};

export default createJestConfig(config);
