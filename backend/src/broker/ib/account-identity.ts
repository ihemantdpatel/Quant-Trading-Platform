/**
 * Which **kind** of IB account an id names — paper or live.
 *
 * `IB_ACCOUNT_ID` is checked against the Gateway login on connect
 * (`checkManagedAccount` in `ib-wire.ts`), and every order is sent to it. That
 * proves the login can trade the id, not that the id is the kind of account
 * `EXECUTION_MODE` claims: a live `U…` id under `PAPER` passed every check,
 * skipped `LIVE`'s reduced-size period, and traded real money at full size.
 * `config.schema.ts` uses this to refuse that pairing at boot.
 */

export enum AccountKind {
  PAPER = 'PAPER',
  LIVE = 'LIVE',
}

/**
 * IB issues paper account ids with a `D` prefix (`DU…` individual, `DF…`
 * advisor); live ids never carry it (`U…`, `F…`, `I…`).
 *
 * The prefix is the only signal the API offers — there is no "is paper" field.
 * Anything not recognisably paper is classed as `LIVE`, which is the direction
 * that fails closed: an unfamiliar id is refused under `PAPER` rather than
 * traded as though it were simulated.
 */
export function accountKindOf(accountId: string): AccountKind {
  return accountId.trim().toUpperCase().startsWith('D') ? AccountKind.PAPER : AccountKind.LIVE;
}
