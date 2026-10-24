# QQQ wheel: first paper version

This branch adds a native wheel implementation inspired by ThetaGang's documented
put/call workflow. It does not copy its Python execution engine. GRID continues on
TQQQ in the same daemon and IB paper account. Do not start a second daemon against
the same account to run the wheel.

## Configuration and first run

Open the account's **Wheel** tab. The form is prefilled with the operator's choices:
QQQ, a **USD 160,000 maximum allocation**, and **one contract**. Save, preview, then
explicitly enable paper trading. Saving and previewing submit no orders. Nothing in
this branch connects to or changes the currently running daemon during development.

The existing global 60% cap still applies across strategies. At the code-registry
account's current USD 175,000 equity setting, that is USD 105,000 total. The wheel's
allocation is an upper bound, not permission to override the cap or reserve cash
away from GRID. Insufficient headroom declines a put; it does not increase limits.

Enablement requires PAPER mode, a DU paper account id, durable repositories, and an
options-capable IB connection. It remains disabled on a new installation. Configuration,
enablement, halt recovery, and lifecycle confirmations are stored in account-scoped
strategy snapshots. There is no schema migration for the wheel journal.

Initial selection defaults:

- One standard 100-share USD option contract at a time.
- 21–45 calendar days to expiry; absolute delta at most 0.20.
- Positive bid of at least USD 0.10, open interest at least 100, spread at most 25% of bid.
- Live bid/ask, model delta, and open interest with a quote age of at most 30 seconds.
- SELL DAY limit at the observed bid, checked once a minute from 10:00–15:30 ET.
- Exchange liquid hours additionally prevent holiday and early-close submissions.
- Puts below the market, fully funded at strike × multiplier × contracts.
- Calls covered by confirmed wheel-owned stock, at or above broker stock cost and market.

IB needs market-data permissions for QQQ and its options. Missing greeks, open
interest, cash, or other required evidence causes no order. USD cash is read from
the USD ledger, never from margin buying power. The account P&L breaker receives
USD values; CAD-base P&L is converted using a fresh USD.CAD quote. No other base
currency is currently supported for this wheel. The existing account-equity cap
still uses its reviewed, static USD setting.

## Shared-account safety

The wheel refuses a ticker registered to GRID or another strategy, including a
disabled strategy. It will not claim TQQQ shares. Before each submission it reads
account positions and all working orders, including untagged/manual orders. Stock
BUY commitments and put assignment liabilities share the same gross capital cap.
A short premium never reduces stock exposure in that calculation.

GRID and wheel submission decisions share one account lock. Every option entry
passes the existing risk manager, kill switch, loss breaker, and technical halt.
SELL OPEN is an entry, not an exempt stock exit. Calls additionally need confirmed
owned shares. Order intent, contract identity, and a PREPARED journal record are
durable before the broker is called. An unknown submission outcome is halted and
never retried automatically. Partial fills and repeated execution reports are
recorded without creating duplicate contracts. No fault liquidates positions.

## Expiration and assignment checkpoint

The first version deliberately requires an **operator checkpoint** at option
expiration, put assignment, or call-away. A vanished option and a changed share
balance alone do not prove how the change occurred. The runtime halts rather than
inventing an assignment or adopting someone else's stock.

1. Verify the completed cycle in IB's activity report. Wait for execution replay
   if the daemon was offline at a fill.
2. Check that no QQQ option positions or QQQ working orders remain.
3. Enter the broker activity reference and explanation in the Wheel page, then
   choose **Confirm lifecycle and reconcile**. This explicitly attributes the
   broker's QQQ shares and average cost to the wheel. It never cancels or sells.
4. After put assignment, the next eligible order is a covered call. After a call
   assignment or unassigned put expiry, a flat wheel can write a put again.

A temporary connection/data fault with unchanged positions can instead use
**Verify positions and clear halt**, with a reason. Neither action clears GRID's
own technical halt, the kill switch, or the loss breaker.

Disabling stops new wheel submissions and leaves existing broker orders working.
Use TWS to cancel one deliberately, then let the next reconciliation observe the
terminal outcome. The wheel cannot be reconfigured while it holds stock or an
unsettled cycle. Engine reset is refused while a wheel journal is configured,
because clearing shared order/fill/snapshot repositories would destroy recovery.

## API

All routes target the current account's existing backend:

- `GET /wheel`: configuration, enablement, halt, owned shares, order journal, audit.
- `POST /wheel/configure`: e.g. `{"symbol":"QQQ","allocation":160000,"maxContracts":1}`.
- `POST /wheel/preview`: live eligibility preview; submits nothing.
- `POST /wheel/enable`, `/wheel/disable`: control scheduled execution.
- `POST /wheel/run`: check and place now, subject to enablement and every guard.
- `POST /wheel/reconcile` and `/wheel/clear-halt`: `{"reference":"IB activity reference and reason"}`.

## Scope and validation

No automatic rolling, buybacks, spreads, margin leverage, or LIVE enablement is
included. Historical equity fixtures do not model options or demonstrate wheel
returns. Tests use explicit option quotes and broker events to cover selection,
funding, assignment/call transitions, partial fills, replay, ambiguous submissions,
and restarts. Real Gateway behavior, subscriptions, and a complete paper-account
cycle still need validation before considering any LIVE work.

Reference: https://github.com/brndnmtthws/thetagang
