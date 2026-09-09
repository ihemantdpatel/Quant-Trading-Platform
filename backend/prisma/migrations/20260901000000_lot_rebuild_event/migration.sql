-- CreateTable
CREATE TABLE `LotRebuildEvent` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `symbol` VARCHAR(32) NOT NULL,
    `strategyId` VARCHAR(128) NOT NULL,
    `triggerCode` VARCHAR(32) NOT NULL,
    `action` VARCHAR(32) NOT NULL,
    `brokerQuantity` INTEGER NOT NULL,
    `brokerAverageCost` DECIMAL(18, 6) NOT NULL,
    `priorLotQuantity` INTEGER NOT NULL,
    `resultingLots` JSON NOT NULL,
    `detail` TEXT NOT NULL,
    `timestamp` VARCHAR(32) NOT NULL,

    INDEX `lot_rebuild_event_time`(`timestamp`),
    INDEX `lot_rebuild_event_symbol`(`symbol`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

