-- CreateTable
CREATE TABLE `PositionSnapshot` (
    `accountId` VARCHAR(64) NOT NULL,
    `takenAt` VARCHAR(32) NOT NULL,
    `symbol` VARCHAR(32) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `averageCost` DECIMAL(18, 6) NOT NULL,

    PRIMARY KEY (`accountId`, `takenAt`, `symbol`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PositionSnapshot` ADD CONSTRAINT `PositionSnapshot_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
