/**
 * The `Decimal` ↔ `number` boundary.
 *
 * The schema stores every price as `DECIMAL(18,6)` because binary floating
 * point drifts a cost basis, and Story 9 compares the *sum* of held lot
 * quantities against a broker's net position for exact equality. But the
 * repository interfaces are declared in plain `number` (`lot.ts`, `rung.ts`),
 * and Story 8's whole premise is that Prisma swaps in with **no call-site
 * changes** (`stories.md:487`). Widening the domain types to `Decimal` would
 * push a persistence concern into the strategy layer — which is not allowed to
 * import anything I/O-shaped in the first place.
 *
 * So the conversion happens here, at the edge, and nowhere else.
 *
 * ## Why this is safe for the values this system stores
 *
 * An IEEE-754 double represents every integer up to 2^53 exactly, and a
 * 6-decimal-place value scaled by 10^6 stays far inside that range for any
 * realistic price or notional. The lossy direction is arithmetic performed in
 * `number`, not the representation itself — which is why the *database* keeps
 * `DECIMAL`, so sums and comparisons that matter happen there or on values that
 * round-trip exactly.
 */

import { Prisma } from '@prisma/client';

/** A Prisma `Decimal` as it arrives from a query. */
type DecimalLike = Prisma.Decimal;

/**
 * Reads a `Decimal` column into the `number` the domain types declare.
 *
 * `toNumber()` rather than `Number(d.toString())`: identical for in-range
 * values, but it is the connector's own conversion, so it stays correct if the
 * underlying representation ever changes.
 */
export function toNumber(value: DecimalLike): number {
  return value.toNumber();
}

/** Nullable variant — `exitPrice` and `closedAt` are null while a lot is held. */
export function toNumberOrNull(value: DecimalLike | null): number | null {
  return value === null ? null : value.toNumber();
}

/**
 * Writes a `number` into a `Decimal` column.
 *
 * Routed through the string form deliberately. `new Decimal(0.1 + 0.2)` would
 * carry the full binary artefact (`0.30000000000000004`) into a
 * `DECIMAL(18,6)` column and silently round it; going via `toString()` uses
 * JavaScript's shortest round-trip representation, so what lands in the column
 * is the value the caller actually meant.
 */
export function toDecimal(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value.toString());
}

/** Nullable variant, for columns that are null until a lot closes. */
export function toDecimalOrNull(value: number | null | undefined): Prisma.Decimal | null {
  return value === null || value === undefined ? null : toDecimal(value);
}
