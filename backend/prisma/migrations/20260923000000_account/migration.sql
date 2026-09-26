-- Accounts become the top-level owner of every per-account row.
--
-- Every row that exists today was produced by the one account this system has
-- traded, so it is assigned to that account's alias, `nuuixl118`. The IB
-- account id is deliberately NOT written here: it stays in each daemon's
-- gitignored `.env`, and `AccountRegistrationService` pins it on first boot.
--
-- The backfill rides on `ADD COLUMN ... DEFAULT 'nuuixl118'` rather than an
-- `UPDATE`. That matters for `ParameterChange` and `PerSymbolLimitChange`,
-- whose BEFORE UPDATE triggers reject any row update: DDL fills the column
-- without firing row triggers, so the append-only guarantee is never
-- suspended — not even inside this migration. The default is dropped at the
-- end so no future insert can silently land in this account by omission.
--
-- Shared tables (`Instrument`, `Bar`, `BacktestRun`, `BacktestResult`) are
-- untouched: market data and backtests belong to no account.

-- CreateTable
CREATE TABLE `Account` (
    `id` VARCHAR(64) NOT NULL,
    `ibAccountId` VARCHAR(32) NULL,
    `label` VARCHAR(128) NOT NULL,
    `createdAt` VARCHAR(32) NOT NULL,

    UNIQUE INDEX `Account_ibAccountId_key`(`ibAccountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The account every existing row belongs to. Inserted before any column
-- references it, so the foreign keys below validate against a real row.
INSERT INTO `Account` (`id`, `ibAccountId`, `label`, `createdAt`)
VALUES ('nuuixl118', NULL, 'nuuixl118', DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'));

-- DropForeignKey
ALTER TABLE `StrategyStateSnapshot` DROP FOREIGN KEY `StrategyStateSnapshot_strategyId_fkey`;

-- DropIndex
DROP INDEX `order_intent_symbol` ON `OrderIntent`;

-- DropIndex
DROP INDEX `order_symbol` ON `Order`;

-- DropIndex
DROP INDEX `fill_client_order` ON `Fill`;

-- DropIndex
DROP INDEX `lot_symbol_fifo` ON `Lot`;

-- DropIndex
DROP INDEX `lot_symbol_status` ON `Lot`;

-- DropIndex
DROP INDEX `grid_lot_symbol_fifo` ON `GridLot`;

-- DropIndex
DROP INDEX `grid_lot_strategy_status` ON `GridLot`;

-- DropIndex
DROP INDEX `snapshot_strategy_time` ON `StrategyStateSnapshot`;

-- DropIndex
DROP INDEX `risk_event_time` ON `RiskEvent`;

-- DropIndex
DROP INDEX `lot_rebuild_event_time` ON `LotRebuildEvent`;

-- DropIndex
DROP INDEX `lot_rebuild_event_symbol` ON `LotRebuildEvent`;

-- DropIndex
DROP INDEX `parameter_change_strategy` ON `ParameterChange`;

-- DropIndex
DROP INDEX `parameter_change_group` ON `ParameterChange`;

-- DropIndex
DROP INDEX `per_symbol_limit_change_symbol` ON `PerSymbolLimitChange`;

-- AlterTable
ALTER TABLE `OrderIntent` DROP PRIMARY KEY,
    ADD COLUMN `accountId` VARCHAR(64) NOT NULL DEFAULT 'nuuixl118',
    ADD PRIMARY KEY (`accountId`, `id`);

-- AlterTable
ALTER TABLE `Order` DROP PRIMARY KEY,
    ADD COLUMN `accountId` VARCHAR(64) NOT NULL DEFAULT 'nuuixl118',
    ADD PRIMARY KEY (`accountId`, `clientOrderId`);

-- AlterTable
ALTER TABLE `Fill` DROP PRIMARY KEY,
    ADD COLUMN `accountId` VARCHAR(64) NOT NULL DEFAULT 'nuuixl118',
    ADD PRIMARY KEY (`accountId`, `fillId`);

-- AlterTable
ALTER TABLE `Position` DROP PRIMARY KEY,
    ADD COLUMN `accountId` VARCHAR(64) NOT NULL DEFAULT 'nuuixl118',
    ADD PRIMARY KEY (`accountId`, `symbol`);

-- AlterTable
ALTER TABLE `Lot` DROP PRIMARY KEY,
    ADD COLUMN `accountId` VARCHAR(64) NOT NULL DEFAULT 'nuuixl118',
    ADD PRIMARY KEY (`accountId`, `id`);

-- AlterTable
ALTER TABLE `Rung` DROP PRIMARY KEY,
    ADD COLUMN `accountId` VARCHAR(64) NOT NULL DEFAULT 'nuuixl118',
    ADD PRIMARY KEY (`accountId`, `symbol`, `price`);

-- AlterTable
ALTER TABLE `GridLot` DROP PRIMARY KEY,
    ADD COLUMN `accountId` VARCHAR(64) NOT NULL DEFAULT 'nuuixl118',
    ADD PRIMARY KEY (`accountId`, `id`);

-- AlterTable
ALTER TABLE `StrategyInstance` DROP PRIMARY KEY,
    ADD COLUMN `accountId` VARCHAR(64) NOT NULL DEFAULT 'nuuixl118',
    ADD PRIMARY KEY (`accountId`, `id`);

-- AlterTable
ALTER TABLE `StrategyStateSnapshot` ADD COLUMN `accountId` VARCHAR(64) NOT NULL DEFAULT 'nuuixl118';

-- AlterTable
ALTER TABLE `RiskEvent` ADD COLUMN `accountId` VARCHAR(64) NOT NULL DEFAULT 'nuuixl118';

-- AlterTable
ALTER TABLE `LotRebuildEvent` ADD COLUMN `accountId` VARCHAR(64) NOT NULL DEFAULT 'nuuixl118';

-- AlterTable
ALTER TABLE `ParameterChange` DROP PRIMARY KEY,
    ADD COLUMN `accountId` VARCHAR(64) NOT NULL DEFAULT 'nuuixl118',
    ADD PRIMARY KEY (`accountId`, `id`);

-- AlterTable
ALTER TABLE `PerSymbolLimitChange` DROP PRIMARY KEY,
    ADD COLUMN `accountId` VARCHAR(64) NOT NULL DEFAULT 'nuuixl118',
    ADD PRIMARY KEY (`accountId`, `id`);

-- CreateIndex
CREATE INDEX `order_intent_symbol` ON `OrderIntent`(`accountId`, `symbol`);

-- CreateIndex
CREATE INDEX `order_symbol` ON `Order`(`accountId`, `symbol`);

-- CreateIndex
CREATE INDEX `fill_client_order` ON `Fill`(`accountId`, `clientOrderId`);

-- CreateIndex
CREATE INDEX `lot_symbol_fifo` ON `Lot`(`accountId`, `symbol`, `openedAt`, `id`);

-- CreateIndex
CREATE INDEX `lot_symbol_status` ON `Lot`(`accountId`, `symbol`, `status`);

-- CreateIndex
CREATE INDEX `grid_lot_symbol_fifo` ON `GridLot`(`accountId`, `symbol`, `openedAt`, `id`);

-- CreateIndex
CREATE INDEX `grid_lot_strategy_status` ON `GridLot`(`accountId`, `strategyId`, `status`);

-- CreateIndex
CREATE INDEX `snapshot_strategy_time` ON `StrategyStateSnapshot`(`accountId`, `strategyId`, `capturedAt`);

-- CreateIndex
CREATE INDEX `risk_event_time` ON `RiskEvent`(`accountId`, `timestamp`);

-- CreateIndex
CREATE INDEX `lot_rebuild_event_time` ON `LotRebuildEvent`(`accountId`, `timestamp`);

-- CreateIndex
CREATE INDEX `lot_rebuild_event_symbol` ON `LotRebuildEvent`(`accountId`, `symbol`);

-- CreateIndex
CREATE INDEX `parameter_change_strategy` ON `ParameterChange`(`accountId`, `strategyId`);

-- CreateIndex
CREATE INDEX `parameter_change_group` ON `ParameterChange`(`accountId`, `changeId`);

-- CreateIndex
CREATE INDEX `per_symbol_limit_change_symbol` ON `PerSymbolLimitChange`(`accountId`, `symbol`);

-- AddForeignKey
ALTER TABLE `OrderIntent` ADD CONSTRAINT `OrderIntent_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Fill` ADD CONSTRAINT `Fill_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Position` ADD CONSTRAINT `Position_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Lot` ADD CONSTRAINT `Lot_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Rung` ADD CONSTRAINT `Rung_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GridLot` ADD CONSTRAINT `GridLot_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StrategyInstance` ADD CONSTRAINT `StrategyInstance_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StrategyStateSnapshot` ADD CONSTRAINT `StrategyStateSnapshot_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StrategyStateSnapshot` ADD CONSTRAINT `StrategyStateSnapshot_accountId_strategyId_fkey` FOREIGN KEY (`accountId`, `strategyId`) REFERENCES `StrategyInstance`(`accountId`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RiskEvent` ADD CONSTRAINT `RiskEvent_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LotRebuildEvent` ADD CONSTRAINT `LotRebuildEvent_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ParameterChange` ADD CONSTRAINT `ParameterChange_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PerSymbolLimitChange` ADD CONSTRAINT `PerSymbolLimitChange_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill complete: no future row may inherit an owner by omission.
ALTER TABLE `OrderIntent` ALTER COLUMN `accountId` DROP DEFAULT;
ALTER TABLE `Order` ALTER COLUMN `accountId` DROP DEFAULT;
ALTER TABLE `Fill` ALTER COLUMN `accountId` DROP DEFAULT;
ALTER TABLE `Position` ALTER COLUMN `accountId` DROP DEFAULT;
ALTER TABLE `Lot` ALTER COLUMN `accountId` DROP DEFAULT;
ALTER TABLE `Rung` ALTER COLUMN `accountId` DROP DEFAULT;
ALTER TABLE `GridLot` ALTER COLUMN `accountId` DROP DEFAULT;
ALTER TABLE `StrategyInstance` ALTER COLUMN `accountId` DROP DEFAULT;
ALTER TABLE `StrategyStateSnapshot` ALTER COLUMN `accountId` DROP DEFAULT;
ALTER TABLE `RiskEvent` ALTER COLUMN `accountId` DROP DEFAULT;
ALTER TABLE `LotRebuildEvent` ALTER COLUMN `accountId` DROP DEFAULT;
ALTER TABLE `ParameterChange` ALTER COLUMN `accountId` DROP DEFAULT;
ALTER TABLE `PerSymbolLimitChange` ALTER COLUMN `accountId` DROP DEFAULT;
