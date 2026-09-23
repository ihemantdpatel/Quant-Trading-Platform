/**
 * The minimal shape `PostCloseReconcileService` and `OrderPollService` need
 * from whatever reconciliation service they are scheduling.
 *
 * Both jobs originally took a concrete `ReconciliationService`. Widening to
 * this structural interface is what lets `GridReconciliationService` — a
 * deliberately separate, smaller class (see its own file header for why it
 * does not share a base with `ReconciliationService`) — be scheduled by the
 * same two job classes without either job needing to know which kind of
 * reconciler it holds.
 *
 * `ordersUpdated` is optional because it means something the grid strategy's
 * report does not carry: `ReconciliationService.reconcileOrders` corrects
 * stale `Order` rows via `reconcileOrderHistory`, which is strategy-agnostic
 * and therefore already covers the grid strategy's orders too whenever the
 * ladder's own scheduled job runs (see `GridReconciliationService`'s header
 * comment) — duplicating that count on the grid side would either double-count
 * or require a number `GridReconciliationService` deliberately does not compute.
 */
export interface OrderOnlyReconciler {
  reconcileOrders(now: string): Promise<{
    brokerReachable: boolean;
    symbols: string[];
    ordersUpdated?: number;
  }>;
}
