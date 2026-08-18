/**
 * The three execution modes, ordered by how much damage they can do.
 *
 * **`SHADOW` is retired.** It existed so Stories 0–12 could run the whole path
 * with nothing reaching a broker, and it did that job. It is kept in the enum
 * rather than deleted because `ParameterChange` rows and `RiskEvent` records
 * written while it was live still carry the string, and an enum that cannot
 * represent its own history would make that audit trail unreadable.
 *
 * Nothing selects it any more: `DEFAULT_EXECUTION_MODE` is `PAPER`, and
 * `assertStartupSafe` refuses it outright — see `startup-assertions.ts`.
 *
 * The reason it had to go rather than linger as an option: resting limit orders
 * make a lot the consequence of a **broker fill**, and SHADOW submits nothing.
 * A shadow ladder would therefore record intents forever and never open a lot,
 * which is not a quieter version of live behaviour — it is a different and
 * misleading one. A mode that reports something the system would never do is
 * worse than no mode at all.
 */
export enum ExecutionMode {
  /** @deprecated Retired. Refused at startup; retained so historic rows parse. */
  SHADOW = 'SHADOW',
  PAPER = 'PAPER',
  LIVE = 'LIVE',
}

export const DEFAULT_EXECUTION_MODE = ExecutionMode.PAPER;
