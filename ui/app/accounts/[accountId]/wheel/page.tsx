import { loadWheel } from '../../../lib/api';
import { WheelControls } from './WheelControls';

export const dynamic = 'force-dynamic';

export default async function WheelPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const { state, error } = await loadWheel(decodeURIComponent(accountId));
  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">{state?.config?.symbol ?? 'QQQ'} Wheel · Paper</h1>
      <p className="text-sm text-slate-400">
        Sell cash-secured puts, then covered calls on wheel-owned shares. GRID continues on its own
        symbol. The shared account cap and kill switch apply to both.
      </p>
      {error && (
        <p role="alert" className="text-red-300">
          {error}
        </p>
      )}
      <WheelControls key={accountId} state={state} />
    </main>
  );
}
