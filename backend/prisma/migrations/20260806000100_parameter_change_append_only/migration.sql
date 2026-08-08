-- Enforce the append-only property of `ParameterChange` at the database level
-- (`stories.md:494`, `PRD.md:392`).
--
-- The repository interface already omits `update` and `deleteOne`, but an
-- interface is a convention, not an enforcement: this table IS the audit trail
-- for live parameter edits, and an audit trail that can be rewritten is not
-- one. These triggers make the property hold against any client — the ORM, a
-- migration, or a person at a mysql prompt.
--
-- SQLSTATE 45000 is the standard "unhandled user-defined exception", which
-- Prisma surfaces as a query error rather than a silent no-op, so an attempted
-- rewrite fails loudly and testably.
--
-- DELETE is blocked as well as UPDATE. Deleting a row and re-inserting it is
-- rewriting history by another name, and blocking only UPDATE would leave that
-- path open.

CREATE TRIGGER `parameter_change_no_update`
BEFORE UPDATE ON `ParameterChange`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'ParameterChange is append-only: UPDATE is not permitted';

CREATE TRIGGER `parameter_change_no_delete`
BEFORE DELETE ON `ParameterChange`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'ParameterChange is append-only: DELETE is not permitted';
