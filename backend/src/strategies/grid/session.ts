/**
 * Session-date helper, duplicated from `dip-ladder/session-window.ts` rather
 * than imported from it.
 *
 * The grid strategy must not depend on anything under `dip-ladder/` — this
 * feature is strictly additive and parallel, and importing from the ladder's
 * own module would be exactly the kind of coupling that risks destabilizing
 * it. `toEt` itself is a neutral market-data utility, not ladder-specific, so
 * only the two small derived functions are duplicated here.
 */

import { toEt } from '../../market-data/session';

/** The ET calendar date (`yyyy-MM-dd`) a timestamp falls on — the session key. */
export function sessionDateOf(timestamp: string): string {
  return toEt(timestamp).toISODate()!;
}
