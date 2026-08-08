'use client';

/**
 * Periodically re-runs the page's Server Components.
 *
 * The backend exposes no websocket, so the ladder is polled. `router.refresh()`
 * re-fetches on the *server* and patches the result in, which keeps data
 * fetching in Server Components per the repo's conventions rather than moving
 * it into a client-side `useEffect`.
 *
 * Renders a visible toggle rather than polling invisibly: an operator watching
 * a control surface should be able to tell whether what they are looking at is
 * live or frozen, and be able to stop it while reading a specific value.
 *
 * Rendered from the layout, so it polls on every tab — which is what keeps the
 * hoisted kill switch and alerts current wherever the operator is looking.
 */

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

/**
 * Routes where a timed refresh would destroy work in progress.
 *
 * `router.refresh()` re-renders the Server Component tree and remounts the
 * parameter form, discarding half-typed input. A three-second poll makes the
 * form unusable, so the timer stops here — the manual button still works, and
 * `revalidatePath` after a successful edit still updates the page.
 */
const PAUSED_PATHS = ['/parameters'];

export function AutoRefresh({ intervalMs = 3000 }: { intervalMs?: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const [enabled, setEnabled] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);

  const paused = PAUSED_PATHS.includes(pathname);
  const polling = enabled && !paused;

  useEffect(() => {
    if (!polling) {
      return;
    }

    const timer = setInterval(() => {
      router.refresh();
      setLastRefresh(new Date().toLocaleTimeString());
    }, intervalMs);

    return () => clearInterval(timer);
  }, [polling, intervalMs, router]);

  return (
    <div className="flex items-center gap-2 text-xs text-slate-400">
      <button
        type="button"
        onClick={() => setEnabled((value) => !value)}
        disabled={paused}
        className="rounded border border-slate-700 px-2 py-1 transition hover:bg-slate-800 disabled:opacity-40"
      >
        {enabled ? '⏸ Pause' : '▶ Resume'}
      </button>
      <span>
        {/* Says why it is not live, so a still page does not read as a stalled one. */}
        {paused
          ? 'Paused while editing'
          : enabled
            ? `Live · every ${intervalMs / 1000}s`
            : 'Paused'}
        {lastRefresh ? ` · ${lastRefresh}` : ''}
      </span>
      <button
        type="button"
        onClick={() => {
          router.refresh();
          setLastRefresh(new Date().toLocaleTimeString());
        }}
        className="rounded border border-slate-700 px-2 py-1 transition hover:bg-slate-800"
      >
        Refresh now
      </button>
    </div>
  );
}
