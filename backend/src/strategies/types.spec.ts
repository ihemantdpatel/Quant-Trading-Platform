import {
  Contract,
  equityContract,
  isOptionContract,
  OptionRight,
  optionContract,
  SecurityType,
} from './types';

/**
 * `Contract` must model options from day one (`PRD.md:224`). The round-trip
 * tests are the check that matters: an option that loses its strike or expiry
 * through serialization is an option that cannot be ordered, and that failure
 * would surface at Story 16 as a rewrite rather than a bug.
 */
describe('Contract', () => {
  it('builds an equity contract with a multiplier of 1', () => {
    const contract = equityContract('TQQQ');

    expect(contract).toEqual({
      symbol: 'TQQQ',
      secType: SecurityType.STOCK,
      exchange: 'SMART',
      currency: 'USD',
      multiplier: 1,
    });
  });

  it('round-trips an equity contract through JSON unchanged', () => {
    const contract = equityContract('TQQQ');

    expect(JSON.parse(JSON.stringify(contract))).toEqual(contract);
  });

  it('builds an option contract with strike, expiry, right, and multiplier', () => {
    const contract = optionContract({
      symbol: 'TQQQ',
      strike: 85,
      expiry: '2026-01-16',
      right: OptionRight.PUT,
    });

    expect(contract.secType).toBe(SecurityType.OPTION);
    expect(contract.strike).toBe(85);
    expect(contract.expiry).toBe('2026-01-16');
    expect(contract.right).toBe(OptionRight.PUT);
    // 100 shares per contract is the US equity option standard; a wrong
    // multiplier misprices the order by 100x.
    expect(contract.multiplier).toBe(100);
  });

  it('round-trips an option contract through JSON with every option field intact', () => {
    const contract = optionContract({
      symbol: 'TQQQ',
      strike: 85,
      expiry: '2026-01-16',
      right: OptionRight.CALL,
      multiplier: 100,
    });

    const roundTripped = JSON.parse(JSON.stringify(contract)) as Contract;

    expect(roundTripped).toEqual(contract);
    expect(isOptionContract(roundTripped)).toBe(true);
  });

  it('honours an explicit non-standard multiplier and currency', () => {
    const contract = optionContract({
      symbol: 'XYZ',
      strike: 10,
      expiry: '2026-06-19',
      right: OptionRight.CALL,
      multiplier: 10,
      currency: 'CAD',
    });

    expect(contract.multiplier).toBe(10);
    expect(contract.currency).toBe('CAD');
  });

  describe('isOptionContract', () => {
    it('is false for an equity contract', () => {
      expect(isOptionContract(equityContract('TQQQ'))).toBe(false);
    });

    it('is true for a complete option contract', () => {
      expect(
        isOptionContract(
          optionContract({
            symbol: 'TQQQ',
            strike: 85,
            expiry: '2026-01-16',
            right: OptionRight.PUT,
          }),
        ),
      ).toBe(true);
    });

    it.each([
      ['strike', { strike: undefined }],
      ['expiry', { expiry: undefined }],
      ['right', { right: undefined }],
    ])('is false for an option missing its %s', (_field, override) => {
      // A half-populated option must not be mistaken for a valid one at the
      // point an order payload is generated.
      const contract: Contract = {
        ...optionContract({
          symbol: 'TQQQ',
          strike: 85,
          expiry: '2026-01-16',
          right: OptionRight.PUT,
        }),
        ...override,
      };

      expect(isOptionContract(contract)).toBe(false);
    });
  });
});
