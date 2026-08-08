-- CreateTable
CREATE TABLE `Instrument` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `symbol` VARCHAR(32) NOT NULL,
    `secType` VARCHAR(16) NOT NULL,
    `exchange` VARCHAR(32) NULL,
    `currency` VARCHAR(8) NOT NULL,
    `strike` DECIMAL(18, 6) NULL,
    `expiry` VARCHAR(16) NULL,
    `right` VARCHAR(8) NULL,
    `multiplier` INTEGER NULL,

    UNIQUE INDEX `Instrument_symbol_secType_strike_expiry_right_key`(`symbol`, `secType`, `strike`, `expiry`, `right`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Bar` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `instrumentId` INTEGER NOT NULL,
    `symbol` VARCHAR(32) NOT NULL,
    `barSize` VARCHAR(16) NOT NULL,
    `timestamp` VARCHAR(32) NOT NULL,
    `open` DECIMAL(18, 6) NOT NULL,
    `high` DECIMAL(18, 6) NOT NULL,
    `low` DECIMAL(18, 6) NOT NULL,
    `close` DECIMAL(18, 6) NOT NULL,
    `volume` BIGINT NOT NULL,
    `synthetic` BOOLEAN NOT NULL DEFAULT false,

    INDEX `bar_symbol_size_time`(`symbol`, `barSize`, `timestamp`),
    UNIQUE INDEX `Bar_symbol_barSize_timestamp_key`(`symbol`, `barSize`, `timestamp`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderIntent` (
    `id` VARCHAR(191) NOT NULL,
    `strategyId` VARCHAR(128) NOT NULL,
    `symbol` VARCHAR(32) NOT NULL,
    `side` VARCHAR(8) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `orderType` VARCHAR(16) NOT NULL,
    `limitPrice` DECIMAL(18, 6) NOT NULL,
    `timeInForce` VARCHAR(16) NOT NULL,
    `timestamp` VARCHAR(32) NOT NULL,
    `reason` TEXT NOT NULL,
    `intent` JSON NOT NULL,
    `decision` JSON NULL,
    `submitted` BOOLEAN NOT NULL DEFAULT false,
    `clientOrderId` VARCHAR(128) NULL,
    `createdAt` VARCHAR(32) NOT NULL,

    INDEX `order_intent_symbol`(`symbol`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Order` (
    `clientOrderId` VARCHAR(128) NOT NULL,
    `brokerOrderId` VARCHAR(128) NULL,
    `symbol` VARCHAR(32) NOT NULL,
    `side` VARCHAR(8) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `limitPrice` DECIMAL(18, 6) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `rejectReason` TEXT NULL,
    `strategyId` VARCHAR(128) NOT NULL,
    `createdAt` VARCHAR(32) NOT NULL,

    INDEX `order_symbol`(`symbol`),
    PRIMARY KEY (`clientOrderId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Fill` (
    `fillId` VARCHAR(191) NOT NULL,
    `clientOrderId` VARCHAR(128) NOT NULL,
    `brokerOrderId` VARCHAR(128) NULL,
    `symbol` VARCHAR(32) NOT NULL,
    `side` VARCHAR(8) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `price` DECIMAL(18, 6) NOT NULL,
    `commission` DECIMAL(18, 6) NOT NULL,
    `timestamp` VARCHAR(32) NOT NULL,

    INDEX `fill_client_order`(`clientOrderId`),
    PRIMARY KEY (`fillId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Position` (
    `symbol` VARCHAR(32) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `averageCost` DECIMAL(18, 6) NOT NULL,
    `updatedAt` VARCHAR(32) NOT NULL,

    PRIMARY KEY (`symbol`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Lot` (
    `id` VARCHAR(191) NOT NULL,
    `symbol` VARCHAR(32) NOT NULL,
    `rungPrice` DECIMAL(18, 6) NOT NULL,
    `fillPrice` DECIMAL(18, 6) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `openedAt` VARCHAR(32) NOT NULL,
    `exitTarget` DECIMAL(18, 6) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `closedAt` VARCHAR(32) NULL,
    `exitPrice` DECIMAL(18, 6) NULL,

    INDEX `lot_symbol_fifo`(`symbol`, `openedAt`, `id`),
    INDEX `lot_symbol_status`(`symbol`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Rung` (
    `symbol` VARCHAR(32) NOT NULL,
    `price` DECIMAL(18, 6) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `lotId` VARCHAR(191) NULL,
    `completedCycles` INTEGER NOT NULL DEFAULT 0,
    `lastExitAt` VARCHAR(32) NULL,

    PRIMARY KEY (`symbol`, `price`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StrategyInstance` (
    `id` VARCHAR(128) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `symbols` JSON NOT NULL,
    `updatedAt` VARCHAR(32) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StrategyStateSnapshot` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `strategyId` VARCHAR(128) NOT NULL,
    `version` INTEGER NOT NULL,
    `symbols` JSON NOT NULL,
    `data` JSON NOT NULL,
    `capturedAt` VARCHAR(32) NOT NULL,

    INDEX `snapshot_strategy_time`(`strategyId`, `capturedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RiskEvent` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `type` VARCHAR(32) NOT NULL,
    `reason` VARCHAR(64) NOT NULL,
    `detail` TEXT NOT NULL,
    `timestamp` VARCHAR(32) NOT NULL,
    `intent` JSON NULL,
    `approvedQuantity` INTEGER NULL,

    INDEX `risk_event_time`(`timestamp`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ParameterChange` (
    `id` VARCHAR(191) NOT NULL,
    `changeId` VARCHAR(191) NOT NULL,
    `strategyId` VARCHAR(128) NOT NULL,
    `parameter` VARCHAR(64) NOT NULL,
    `oldValue` JSON NOT NULL,
    `newValue` JSON NOT NULL,
    `timestamp` VARCHAR(32) NOT NULL,
    `stateAtChange` JSON NULL,
    `reason` TEXT NULL,

    INDEX `parameter_change_strategy`(`strategyId`),
    INDEX `parameter_change_group`(`changeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BacktestRun` (
    `id` VARCHAR(191) NOT NULL,
    `strategyId` VARCHAR(128) NOT NULL,
    `symbol` VARCHAR(32) NOT NULL,
    `barSize` VARCHAR(16) NOT NULL,
    `rangeStart` VARCHAR(32) NOT NULL,
    `rangeEnd` VARCHAR(32) NOT NULL,
    `parameters` JSON NOT NULL,
    `synthetic` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` VARCHAR(32) NOT NULL,

    INDEX `backtest_run_strategy_time`(`strategyId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BacktestResult` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `metric` VARCHAR(64) NOT NULL,
    `value` DECIMAL(24, 8) NOT NULL,
    `detail` JSON NULL,

    UNIQUE INDEX `BacktestResult_runId_metric_key`(`runId`, `metric`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Bar` ADD CONSTRAINT `Bar_instrumentId_fkey` FOREIGN KEY (`instrumentId`) REFERENCES `Instrument`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StrategyStateSnapshot` ADD CONSTRAINT `StrategyStateSnapshot_strategyId_fkey` FOREIGN KEY (`strategyId`) REFERENCES `StrategyInstance`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BacktestResult` ADD CONSTRAINT `BacktestResult_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `BacktestRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

