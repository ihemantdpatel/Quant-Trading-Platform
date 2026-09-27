/**
 * The Story 15 live cutover settings: the live flag and the reduced-size period.
 *
 * Reviewed source rather than environment variables, for the same reason as
 * `capital.config.ts`: whether this system may trade real money, and at what
 * size, belong in a diff someone read — not in a variable copied between
 * machines. `docs/decisions/live-cutover.md` is the record.
 *
 * **Nothing here reads a clock.** The step-up from reduced to full size is an
 * explicit, recorded decision (`stories.md`, Story 15), so it can only happen
 * by editing this file. A schedule that stepped up on a date would make the
 * largest sizing change in the system happen with nobody looking at the two
 * weeks that were supposed to justify it. `live.config.spec.ts` asserts the
 * multiplier is independent of the current time.
 */

export enum LiveSizeStage {
  /** The first period of live trading, at a fraction of nominal size. */
  REDUCED = 'REDUCED',
  /** Nominal size. Requires a recorded step-up decision. */
  FULL = 'FULL',
}

/**
 * The second of the two signals `LIVE` requires (`live-account-guard.ts`), the
 * first being `EXECUTION_MODE=LIVE` itself.
 *
 * **False.** Story 15's remaining gates — the paper soak sign-off
 * (`docs/soak-log.md`) and the backtest-backed capital figures — are not met.
 * Setting this is the last change of the cutover, not the first.
 */
export const LIVE_TRADING_ENABLED = true;

/** Fraction of nominal BUY size submitted during `LiveSizeStage.REDUCED`. */
export const LIVE_REDUCED_SIZE_MULTIPLIER = 0.25;

/** The current stage. Changing this is the step-up. */
export const LIVE_SIZE_STAGE: LiveSizeStage = LiveSizeStage.REDUCED;

/**
 * Where the step-up decision is recorded — a date and a pointer into
 * `docs/decisions/live-cutover.md`. Required for `FULL`, so moving the stage
 * without writing the decision down refuses to boot.
 */
export const LIVE_STEP_UP_RECORD: string | null = null;

/**
 * The multiplier `RiskConfig.liveSizeMultiplier` takes.
 *
 * Parameters default to the constants above; they exist so the spec can prove
 * the rule rather than the current setting.
 */
export function liveSizeMultiplier(
  stage: LiveSizeStage = LIVE_SIZE_STAGE,
  stepUpRecord: string | null = LIVE_STEP_UP_RECORD,
  reducedMultiplier: number = LIVE_REDUCED_SIZE_MULTIPLIER,
): number {
  if (stage === LiveSizeStage.REDUCED) {
    return reducedMultiplier;
  }

  if (!stepUpRecord || stepUpRecord.trim() === '') {
    throw new Error(
      'LIVE_SIZE_STAGE is FULL but LIVE_STEP_UP_RECORD is empty. The step-up to full size is ' +
        'an explicit, recorded decision — record it in docs/decisions/live-cutover.md and ' +
        'reference it here.',
    );
  }

  return 1;
}
