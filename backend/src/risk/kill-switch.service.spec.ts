import { KillSwitchService } from './kill-switch.service';
import { InMemoryRiskEventSink, RiskEventType } from './risk-event';

const AT = '2026-03-02T10:00:00-05:00';

describe('KillSwitchService', () => {
  let sink: InMemoryRiskEventSink;
  let killSwitch: KillSwitchService;

  beforeEach(() => {
    sink = new InMemoryRiskEventSink();
    killSwitch = new KillSwitchService(sink);
  });

  it('starts disengaged', () => {
    expect(killSwitch.isEngaged()).toBe(false);
    expect(killSwitch.snapshot()).toEqual({ engaged: false, reason: null, changedAt: null });
  });

  it('engages and records the reason', () => {
    expect(killSwitch.engage('operator halt', AT)).toBe(true);

    expect(killSwitch.isEngaged()).toBe(true);
    expect(killSwitch.snapshot()).toEqual({
      engaged: true,
      reason: 'operator halt',
      changedAt: AT,
    });
  });

  it('emits exactly one RiskEvent on engagement', () => {
    killSwitch.engage('operator halt', AT);

    const events = sink.ofType(RiskEventType.KILL_SWITCH);
    expect(events).toHaveLength(1);
    expect(events[0].detail).toContain('engaged');
    expect(events[0].intent).toBeNull();
  });

  it('is idempotent — a second engage changes nothing and emits nothing', () => {
    killSwitch.engage('first', AT);

    expect(killSwitch.engage('second', AT)).toBe(false);
    expect(killSwitch.snapshot().reason).toBe('first');
    expect(sink.ofType(RiskEventType.KILL_SWITCH)).toHaveLength(1);
  });

  it('releases and audits the release with its own reason', () => {
    killSwitch.engage('halt', AT);

    expect(killSwitch.release('investigated, resuming', AT)).toBe(true);
    expect(killSwitch.isEngaged()).toBe(false);
    expect(sink.ofType(RiskEventType.KILL_SWITCH)).toHaveLength(2);
    expect(sink.all()[1].detail).toContain('released');
  });

  it('releasing a disengaged switch is a no-op', () => {
    expect(killSwitch.release('nothing to do', AT)).toBe(false);
    expect(sink.all()).toHaveLength(0);
  });

  it('returns a snapshot copy that cannot mutate internal state', () => {
    const snapshot = killSwitch.snapshot();
    snapshot.engaged = true;

    expect(killSwitch.isEngaged()).toBe(false);
  });

  it('works without a sink, for pure and test contexts', () => {
    const bare = new KillSwitchService();

    expect(bare.engage('no sink', AT)).toBe(true);
    expect(bare.isEngaged()).toBe(true);
  });

  it('exposes no method that could liquidate a position', () => {
    const methods = Object.getOwnPropertyNames(KillSwitchService.prototype);

    expect(methods).not.toContain('liquidate');
    expect(methods.join(' ')).not.toMatch(/sell|close|flatten/i);
  });
});
