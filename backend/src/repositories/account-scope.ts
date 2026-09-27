/**
 * The account a repository reads and writes on behalf of.
 *
 * Bound once, at construction, rather than passed to every method: a scope
 * that each call site had to remember is a scope some call site would forget,
 * and a forgotten filter here reads another account's lots into this account's
 * lot-sum assertion. No repository method takes an account, so no caller can
 * name the wrong one.
 *
 * Only the Prisma repositories consult it. The in-memory repositories hold
 * their rows in the memory of the one process — the one account — that
 * created them, so there is nothing for a second account to see.
 */
export const ACCOUNT_ID = Symbol('ACCOUNT_ID');
