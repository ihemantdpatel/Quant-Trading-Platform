/**
 * `Contract` — the instrument vocabulary, shared by every layer.
 *
 * Lives in `src/domain/` rather than in `src/strategies/` deliberately. A
 * contract is not strategy logic: the broker adapter needs it to build an order
 * payload, the repositories persist it, and strategies produce it. Declaring it
 * inside the strategy layer would force the broker to import from
 * `strategies/`, which `architecture.spec.ts` forbids — and rightly so, since
 * that import is exactly how strategy logic would start leaking across the
 * boundary. A neutral module lets every layer share the type without any layer
 * depending on another.
 *
 * **Options are modelled from day one** (`PRD.md:224`). Phase 1 trades ETF
 * shares only, but retrofitting strike/expiry/right/multiplier into an
 * equity-shaped model is a rewrite, and both the Wheel and LEAPs need it.
 */

export enum SecurityType {
  /** Shares. Everything Phase 1 trades. */
  STOCK = 'STK',
  /** Declared from day one — the Wheel and LEAPs are built on it. */
  OPTION = 'OPT',
}

export enum OptionRight {
  CALL = 'C',
  PUT = 'P',
}

/**
 * An instrument.
 *
 * The option fields are optional rather than a separate `OptionContract` type
 * so that one `Contract` flows through intents, orders, repositories, and the
 * broker adapter unchanged. A discriminated union would force every one of
 * those layers to branch, which is the retrofit `PRD.md:224` warns against —
 * just deferred to a different place.
 *
 * `isOptionContract` below is the guard that keeps the optionality honest.
 */
export interface Contract {
  symbol: string;
  secType: SecurityType;
  /** Exchange routing. `SMART` is IB's order router and the sane default. */
  exchange: string;
  currency: string;
  /** Options only. Strike price. */
  strike?: number;
  /** Options only. ISO date `YYYY-MM-DD` — IB's `YYYYMMDD` is a wire format. */
  expiry?: string;
  right?: OptionRight;
  /**
   * Shares per contract. 100 for a standard US equity option, 1 for shares.
   * Explicit rather than inferred, because a wrong multiplier misprices an
   * order by 100x and that is not a mistake to leave implicit.
   */
  multiplier: number;
}

export function equityContract(symbol: string, currency = 'USD'): Contract {
  return {
    symbol,
    secType: SecurityType.STOCK,
    exchange: 'SMART',
    currency,
    multiplier: 1,
  };
}

export interface OptionContractParams {
  symbol: string;
  strike: number;
  /** ISO `YYYY-MM-DD`. */
  expiry: string;
  right: OptionRight;
  multiplier?: number;
  currency?: string;
}

export function optionContract(params: OptionContractParams): Contract {
  return {
    symbol: params.symbol,
    secType: SecurityType.OPTION,
    exchange: 'SMART',
    currency: params.currency ?? 'USD',
    strike: params.strike,
    expiry: params.expiry,
    right: params.right,
    multiplier: params.multiplier ?? 100,
  };
}

/**
 * True when a contract carries a complete option specification.
 *
 * Checks every option field rather than just `secType`, so a half-populated
 * option — a strike with no expiry — is not mistaken for a valid one at the
 * point an order payload is generated.
 */
export function isOptionContract(contract: Contract): boolean {
  return (
    contract.secType === SecurityType.OPTION &&
    typeof contract.strike === 'number' &&
    typeof contract.expiry === 'string' &&
    contract.right !== undefined
  );
}
