import { clientOrderSequenceOf, formatClientOrderId, ownsClientOrderId } from './client-order-id';

describe('client order ids', () => {
  describe('formatClientOrderId', () => {
    it('scopes the id to the account', () => {
      expect(formatClientOrderId(7, 'nuuixl118')).toBe('co-nuuixl118-7');
    });

    it('issues the legacy form when no account is configured', () => {
      expect(formatClientOrderId(7, null)).toBe('co-7');
    });
  });

  describe('clientOrderSequenceOf', () => {
    it('reads this account’s scoped ids', () => {
      expect(clientOrderSequenceOf('co-nuuixl118-42', 'nuuixl118')).toBe(42);
    });

    it('handles an alias that itself contains hyphens', () => {
      expect(clientOrderSequenceOf('co-paper-two-9', 'paper-two')).toBe(9);
    });

    it('counts legacy ids, so the first scoped id continues past the last legacy one', () => {
      expect(clientOrderSequenceOf('co-500', 'nuuixl118')).toBe(500);
      expect(clientOrderSequenceOf('co-500', null)).toBe(500);
    });

    it('ignores another account’s ids', () => {
      expect(clientOrderSequenceOf('co-other-99', 'nuuixl118')).toBeNull();
      expect(clientOrderSequenceOf('co-other-99', null)).toBeNull();
    });

    it('ignores ids this generator never produced', () => {
      expect(clientOrderSequenceOf('manual-order', 'nuuixl118')).toBeNull();
    });
  });

  describe('ownsClientOrderId', () => {
    it('owns its own scoped ids and not a sibling account’s', () => {
      expect(ownsClientOrderId('co-nuuixl118-3', 'nuuixl118')).toBe(true);
      expect(ownsClientOrderId('co-other-3', 'nuuixl118')).toBe(false);
    });

    it('gives legacy ids to the default account only — it was the only account there was', () => {
      expect(ownsClientOrderId('co-3', 'nuuixl118')).toBe(true);
      expect(ownsClientOrderId('co-3', 'other')).toBe(false);
    });

    it('leaves an id it cannot classify to the caller’s own rules', () => {
      expect(ownsClientOrderId('some-other-id', 'nuuixl118')).toBe(true);
    });
  });
});
