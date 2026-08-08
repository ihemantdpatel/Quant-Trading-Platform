/**
 * The three execution modes, ordered by how much damage they can do.
 *
 * SHADOW is the default everywhere and stays the default until Story 13
 * (`stories.md`). In SHADOW the engine logs full order payloads and submits
 * nothing. PAPER and LIVE are declared here so the type exists from day one,
 * but reaching them requires the Story 5 startup assertions.
 */
export enum ExecutionMode {
  SHADOW = 'SHADOW',
  PAPER = 'PAPER',
  LIVE = 'LIVE',
}

export const DEFAULT_EXECUTION_MODE = ExecutionMode.SHADOW;
