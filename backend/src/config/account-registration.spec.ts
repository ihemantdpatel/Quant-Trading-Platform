import { maskAccountId, planAccountRegistration } from './account-registration';

describe('planAccountRegistration', () => {
  const input = {
    alias: 'nuuixl118',
    label: 'nuuixl118',
    ibAccountId: 'DU1234567',
    confirmedByBroker: true,
  };

  it('creates the row pinned to the id once IB has confirmed it', () => {
    expect(planAccountRegistration(input, null, null)).toEqual({
      action: 'CREATE',
      ibAccountId: 'DU1234567',
    });
  });

  it('creates an unpinned row under the mock broker, where there is no id', () => {
    expect(planAccountRegistration({ ...input, ibAccountId: undefined }, null, null)).toEqual({
      action: 'CREATE',
      ibAccountId: null,
    });
  });

  it('pins the id on the first IB-confirmed connect of an account the migration created unpinned', () => {
    // The backfill migration inserts `nuuixl118` with a null id — the id never
    // enters git — so the first live boot after it is the one that pins it.
    const existing = { id: 'nuuixl118', ibAccountId: null, label: 'nuuixl118' };

    expect(planAccountRegistration(input, existing, null)).toEqual({
      action: 'UPDATE',
      ibAccountId: 'DU1234567',
      label: 'nuuixl118',
    });
  });

  it('does nothing when the stored pairing already matches', () => {
    const existing = { id: 'nuuixl118', ibAccountId: 'DU1234567', label: 'nuuixl118' };

    expect(planAccountRegistration(input, existing, 'nuuixl118')).toEqual({ action: 'NONE' });
  });

  it('keeps the pin when a later boot runs on the mock broker with no id', () => {
    const existing = { id: 'nuuixl118', ibAccountId: 'DU1234567', label: 'nuuixl118' };

    expect(planAccountRegistration({ ...input, ibAccountId: undefined }, existing, null)).toEqual({
      action: 'NONE',
    });
  });

  it('follows a label edited in accounts.config.ts without touching the pin', () => {
    const existing = { id: 'nuuixl118', ibAccountId: 'DU1234567', label: 'old label' };

    expect(planAccountRegistration(input, existing, 'nuuixl118')).toEqual({
      action: 'UPDATE',
      ibAccountId: 'DU1234567',
      label: 'nuuixl118',
    });
  });

  it('refuses an alias pinned to a different IB account', () => {
    // The copied-.env case: this alias's lots came from DU1234567's fills and
    // must never be reconciled against DU7654321's position.
    const existing = { id: 'nuuixl118', ibAccountId: 'DU7654321', label: 'nuuixl118' };
    const plan = planAccountRegistration(input, existing, null);

    expect(plan.action).toBe('REFUSE');
    expect(plan).toMatchObject({ failure: expect.stringContaining('pinned to IB account') });
  });

  it('refuses an IB id another alias already owns', () => {
    const plan = planAccountRegistration(input, null, 'other-account');

    expect(plan.action).toBe('REFUSE');
    expect(plan).toMatchObject({ failure: expect.stringContaining('"other-account"') });
  });

  it('never prints the whole id in a refusal', () => {
    const existing = { id: 'nuuixl118', ibAccountId: 'DU7654321', label: 'nuuixl118' };
    const plan = planAccountRegistration(input, existing, null);

    expect(JSON.stringify(plan)).not.toContain('DU1234567');
    expect(JSON.stringify(plan)).not.toContain('DU7654321');
  });
});

describe('planAccountRegistration before IB has confirmed the account', () => {
  // Boot runs before any connect. The configured id is unverified then, and
  // writing it once saved an alias typed into IB_ACCOUNT_ID as an IB id.
  const atBoot = {
    alias: 'nuuixl118',
    label: 'nuuixl118',
    ibAccountId: 'nuuixl118',
    confirmedByBroker: false,
  };

  it('creates the row unpinned', () => {
    expect(planAccountRegistration(atBoot, null, null)).toEqual({
      action: 'CREATE',
      ibAccountId: null,
    });
  });

  it('never pins an unpinned row', () => {
    const existing = { id: 'nuuixl118', ibAccountId: null, label: 'nuuixl118' };

    expect(planAccountRegistration(atBoot, existing, null)).toEqual({ action: 'NONE' });
  });

  it('still refuses a configuration that contradicts a confirmed pin', () => {
    const existing = { id: 'nuuixl118', ibAccountId: 'DU1234567', label: 'nuuixl118' };

    expect(planAccountRegistration(atBoot, existing, null).action).toBe('REFUSE');
  });
});

describe('maskAccountId', () => {
  it('keeps the prefix and last three characters', () => {
    expect(maskAccountId('DU1234567')).toBe('DU•••567');
  });

  it('hides a short id entirely rather than revealing most of it', () => {
    expect(maskAccountId('U123')).toBe('••••');
  });
});
