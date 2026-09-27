import { AccountKind, accountKindOf } from './account-identity';

describe('accountKindOf', () => {
  it.each(['DU1234567', 'DF1234567', 'du1234567', ' DU1 '])('%s is PAPER', (id) => {
    expect(accountKindOf(id)).toBe(AccountKind.PAPER);
  });

  it.each(['U1234567', 'F1234567', 'I1234567', 'X999'])('%s is LIVE', (id) => {
    // Anything not recognisably paper is LIVE — the direction that fails closed
    // under PAPER.
    expect(accountKindOf(id)).toBe(AccountKind.LIVE);
  });
});
