-- CreateTable
CREATE TABLE `GridLot` (
    `id` VARCHAR(191) NOT NULL,
    `strategyId` VARCHAR(128) NOT NULL,
    `symbol` VARCHAR(32) NOT NULL,
    `fillPrice` DECIMAL(18, 6) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `openedAt` VARCHAR(32) NOT NULL,
    `sellTarget` DECIMAL(18, 6) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `closedAt` VARCHAR(32) NULL,
    `exitPrice` DECIMAL(18, 6) NULL,
    `workingOrderId` VARCHAR(191) NULL,

    INDEX `grid_lot_symbol_fifo`(`symbol`, `openedAt`, `id`),
    INDEX `grid_lot_strategy_status`(`strategyId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
