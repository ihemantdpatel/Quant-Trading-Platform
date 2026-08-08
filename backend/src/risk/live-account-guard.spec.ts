import { ExecutionMode } from '../config/execution-mode';
import { checkLiveAccountGuard } from './live-account-guard';
import { buildRiskConfig } from './risk.config';

describe('live-account guard', () => {
  it('refuses LIVE when the explicit flag is absent', () => {
    const verdict = checkLiveAccountGuard(ExecutionMode.LIVE, buildRiskConfig());

    expect(verdict.permitted).toBe(false);
    expect(verdict.detail).toContain('allowLiveTrading');
  });

  it('permits LIVE once the flag is explicitly set', () => {
    const config = buildRiskConfig({ allowLiveTrading: true });

    expect(checkLiveAccountGuard(ExecutionMode.LIVE, config).permitted).toBe(true);
  });

  it('defaults the flag to false — it is never inherited implicitly', () => {
    expect(buildRiskConfig().allowLiveTrading).toBe(false);
  });

  it.each([ExecutionMode.SHADOW, ExecutionMode.PAPER])(
    'does not gate %s on the live flag',
    (mode) => {
      // SHADOW submits nothing and PAPER cannot move real capital. They are
      // gated by the capital and loss-threshold assertions instead.
      expect(checkLiveAccountGuard(mode, buildRiskConfig()).permitted).toBe(true);
    },
  );
});
