/**
 * `RiskParameterService` unit tests.
 *
 * HTTP-level behaviour is covered by `api/risk-parameters.controller` via
 * the dashboard's own integration path; this suite exercises the service
 * directly — validation, the audit trail, and the restore-from-history path
 * that survives a restart, mirroring `parameter.service.spec.ts` for the
 * ladder's equivalent.
 */

import { InMemoryPerSymbolLimitChangeRepository } from '../repositories/in-memory/in-memory.repositories';
import { RiskParameterEditError, RiskParameterService } from './risk-parameter.service';
import { buildRiskConfig, RiskConfig } from './risk.config';

const AT = '2024-03-04T10:00:00.000Z';

describe('RiskParameterService', () => {
  let config: RiskConfig;
  let changes: InMemoryPerSymbolLimitChangeRepository;
  let service: RiskParameterService;

  beforeEach(() => {
    config = buildRiskConfig({ perSymbolLimits: { TQQQ: 40_000 } });
    changes = new InMemoryPerSymbolLimitChangeRepository();
    service = new RiskParameterService(config, changes);
  });

  describe('current', () => {
    it('reads the live config, not a snapshot taken at construction', async () => {
      expect(service.current()).toEqual({ TQQQ: 40_000 });

      await service.edit({ symbol: 'TQQQ', limit: 180_000, timestamp: AT });

      expect(service.current()).toEqual({ TQQQ: 180_000 });
    });
  });

  describe('edit', () => {
    it('refuses a non-positive limit', async () => {
      await expect(service.edit({ symbol: 'TQQQ', limit: 0, timestamp: AT })).rejects.toThrow(
        RiskParameterEditError,
      );
      await expect(service.edit({ symbol: 'TQQQ', limit: -5, timestamp: AT })).rejects.toThrow(
        RiskParameterEditError,
      );
    });

    it('refuses a non-finite limit', async () => {
      await expect(service.edit({ symbol: 'TQQQ', limit: NaN, timestamp: AT })).rejects.toThrow(
        RiskParameterEditError,
      );
    });

    it('refuses an empty symbol', async () => {
      await expect(service.edit({ symbol: '', limit: 100, timestamp: AT })).rejects.toThrow(
        RiskParameterEditError,
      );
    });

    it('mutates the same RiskConfig instance RiskManagerService holds', async () => {
      // The whole mechanism this service relies on: `capital-cap.ts` reads
      // `config.perSymbolLimits[symbol]` fresh on every call, so mutating the
      // object in place is what makes the edit take effect immediately.
      await service.edit({ symbol: 'TQQQ', limit: 180_000, timestamp: AT });

      expect(config.perSymbolLimits.TQQQ).toBe(180_000);
    });

    it('adds a limit for a symbol that had none, reporting oldValue as null', async () => {
      const result = await service.edit({ symbol: 'SPY', limit: 10_000, timestamp: AT });

      expect(result).toEqual({ symbol: 'SPY', oldValue: null, newValue: 10_000, changed: true });
      expect(config.perSymbolLimits.SPY).toBe(10_000);
    });

    it('records old and new values, and the operator reason, on the audit trail', async () => {
      await service.edit({
        symbol: 'TQQQ',
        limit: 180_000,
        timestamp: AT,
        reason: 'account funded to a larger balance',
      });

      const [change] = await changes.findAll();
      expect(change).toMatchObject({
        symbol: 'TQQQ',
        oldValue: 40_000,
        newValue: 180_000,
        timestamp: AT,
        reason: 'account funded to a larger balance',
      });
    });

    it('is a no-op — no audit record, no mutation call — when the value is unchanged', async () => {
      const result = await service.edit({ symbol: 'TQQQ', limit: 40_000, timestamp: AT });

      expect(result).toEqual({
        symbol: 'TQQQ',
        oldValue: 40_000,
        newValue: 40_000,
        changed: false,
      });
      expect(await changes.findAll()).toEqual([]);
    });

    it('validates before recording — a rejected edit leaves no audit trace', async () => {
      await expect(service.edit({ symbol: 'TQQQ', limit: -1, timestamp: AT })).rejects.toThrow();

      expect(await changes.findAll()).toEqual([]);
      expect(config.perSymbolLimits.TQQQ).toBe(40_000);
    });
  });

  describe('restore', () => {
    it('does nothing when the audit log is empty, leaving compiled defaults in force', async () => {
      await service.restore();

      expect(config.perSymbolLimits).toEqual({ TQQQ: 40_000 });
    });

    it('re-applies the latest recorded value per symbol', async () => {
      await changes.append({
        id: 'risk-limit-change-1',
        symbol: 'TQQQ',
        oldValue: 40_000,
        newValue: 180_000,
        timestamp: AT,
        reason: null,
      });

      // A fresh service — as a restart would construct — starting from the
      // compiled default, not the mutated config above.
      const freshConfig = buildRiskConfig({ perSymbolLimits: { TQQQ: 40_000 } });
      const fresh = new RiskParameterService(freshConfig, changes);

      await fresh.restore();

      expect(freshConfig.perSymbolLimits.TQQQ).toBe(180_000);
    });

    it('takes the latest of several records for the same symbol, by timestamp', async () => {
      await changes.append({
        id: 'risk-limit-change-1',
        symbol: 'TQQQ',
        oldValue: 40_000,
        newValue: 60_000,
        timestamp: '2024-03-04T10:00:00.000Z',
        reason: null,
      });
      await changes.append({
        id: 'risk-limit-change-2',
        symbol: 'TQQQ',
        oldValue: 60_000,
        newValue: 180_000,
        timestamp: '2024-03-05T10:00:00.000Z',
        reason: null,
      });

      const freshConfig = buildRiskConfig({ perSymbolLimits: { TQQQ: 40_000 } });
      const fresh = new RiskParameterService(freshConfig, changes);

      await fresh.restore();

      expect(freshConfig.perSymbolLimits.TQQQ).toBe(180_000);
    });

    it('skips a recorded value that is no longer valid, leaving the compiled default', async () => {
      await changes.append({
        id: 'risk-limit-change-1',
        symbol: 'TQQQ',
        oldValue: 40_000,
        newValue: -5,
        timestamp: AT,
        reason: null,
      });

      const freshConfig = buildRiskConfig({ perSymbolLimits: { TQQQ: 40_000 } });
      const fresh = new RiskParameterService(freshConfig, changes);

      await fresh.restore();

      expect(freshConfig.perSymbolLimits.TQQQ).toBe(40_000);
    });

    it('bumps the id sequence past history, so a fresh edit cannot collide with a restored id', async () => {
      await changes.append({
        id: 'risk-limit-change-5',
        symbol: 'TQQQ',
        oldValue: 40_000,
        newValue: 180_000,
        timestamp: AT,
        reason: null,
      });

      const freshConfig = buildRiskConfig({ perSymbolLimits: { TQQQ: 40_000 } });
      const fresh = new RiskParameterService(freshConfig, changes);
      await fresh.restore();

      await fresh.edit({ symbol: 'TQQQ', limit: 200_000, timestamp: AT });

      const ids = (await changes.findAll()).map((c) => c.id);
      expect(ids).toEqual(['risk-limit-change-5', 'risk-limit-change-6']);
    });
  });
});
