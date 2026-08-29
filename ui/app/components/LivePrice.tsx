'use client';

/**
 * The traded instrument's current price, centred in the kill-switch panel.
 *
 * The price itself is fetched on the *server* — it arrives as a prop from the
 * layout's `/status` read, refreshed by `AutoRefresh`'s poll, per the repo's
 * convention of fetching in Server Components. This is a Client Component only
 * so the **age** can tick between polls: a price whose label reads `2s` for as
 * long as the poll interval would overstate how fresh it is, and a stalled
 * poll would leave a stale price looking permanently current.
 *
 * It shows the last *bar close* the feed delivered, not the last fill. That is
 * deliberate: the bar close is the number the ladder itself evaluates against,
 * and a header disagreeing with the ladder's own basis would be worse than one
 * that lags a few minutes behind the tape. It also exists on a flat ladder,
 * where there is no fill to read a price from at all.
 *
 * Type is deliberately large — `text-3xl` (30px) for the price and `text-base`
 * (16px) for the labels, both above the 20px the operator asked for on the
 * figure itself. This is read at a glance from across a desk while deciding
 * whether to engage the control beside it, not scanned like table data.
 */

import { useEffect, useState } from 'react';
import { priceAge, type LastPrice } from '../lib/api';

/**
 * Age past which the price is shown as suspect.
 *
 * Above the 5-minute bar cadence with room to spare, so an ordinary gap
 * between two consecutive bars never paints the header as faulty. The
 * staleness *halt* is the broker's own judgement and is reported by the alert
 * banner; this is only a reading aid.
 */
const SUSPECT_AFTER_MS = 8 * 60_000;

export function LivePrice({ symbol, last }: { symbol: string; last: LastPrice | null }) {
  // Null until mounted, so the server and the first client render agree — a
  // clock read during render would differ between the two and hydrate wrong.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (last === null) {
    return (
      <div className="text-center">
        <p className="text-base uppercase tracking-wide text-slate-500">{symbol}</p>
        {/*
          No price is a real state, not an error: the mock broker has no live
          feed, and against IB no bar has arrived yet before the first one.
          Saying so beats rendering a zero.
        */}
        <p className="font-mono text-3xl font-semibold text-slate-600">—</p>
        <p className="text-base text-slate-600">no live feed</p>
      </div>
    );
  }

  const stale = now !== null && now - last.at > SUSPECT_AFTER_MS;

  return (
    <div className="text-center">
      <p className="text-base uppercase tracking-wide text-slate-500">{symbol}</p>
      <p
        // `aria-live` so a screen reader announces a price change without the
        // operator having to go looking for it.
        aria-live="polite"
        className={`font-mono text-3xl font-semibold tabular-nums ${
          stale ? 'text-amber-400' : 'text-slate-100'
        }`}
      >
        {last.price.toLocaleString('en-US', {
          style: 'currency',
          currency: 'USD',
          minimumFractionDigits: 2,
        })}
      </p>
      <p className={`text-base ${stale ? 'text-amber-500' : 'text-slate-500'}`}>
        {now === null ? 'last bar' : `${priceAge(last.at, now)} ago`}
        {stale ? ' · stale' : ''}
      </p>
    </div>
  );
}
