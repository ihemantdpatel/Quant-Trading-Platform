-- Resting limit orders: a rung may have an order working at the broker while
-- holding no lot yet.
--
-- Nullable with no default, deliberately. "No order resting here" is a genuine
-- state rather than a missing value, and every existing row is exactly that —
-- they predate resting orders — so NULL is the correct backfill and needs no
-- data migration.
ALTER TABLE `Rung` ADD COLUMN `workingOrderId` VARCHAR(191) NULL AFTER `lotId`;
