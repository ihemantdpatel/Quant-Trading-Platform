-- CreateTable
CREATE TABLE `AccountDefinition` (
    `alias` VARCHAR(64) NOT NULL,
    `label` VARCHAR(128) NOT NULL,
    `executionMode` VARCHAR(16) NOT NULL,
    `currency` VARCHAR(8) NOT NULL,
    `equity` DECIMAL(18, 6) NOT NULL,
    `symbolCapital` JSON NOT NULL,
    `dailyLossThreshold` DECIMAL(18, 6) NOT NULL,
    `dailyLossBasis` VARCHAR(32) NOT NULL,
    `ibAccountId` VARCHAR(32) NULL,
    `ibClientId` INTEGER NOT NULL,
    `port` INTEGER NOT NULL,
    `createdAt` VARCHAR(32) NOT NULL,

    UNIQUE INDEX `AccountDefinition_ibAccountId_key`(`ibAccountId`),
    UNIQUE INDEX `AccountDefinition_ibClientId_key`(`ibClientId`),
    UNIQUE INDEX `AccountDefinition_port_key`(`port`),
    PRIMARY KEY (`alias`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AccountDefinitionChange` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `alias` VARCHAR(64) NOT NULL,
    `action` VARCHAR(16) NOT NULL,
    `definition` JSON NOT NULL,
    `reason` TEXT NULL,
    `timestamp` VARCHAR(32) NOT NULL,

    INDEX `account_definition_change_alias`(`alias`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Append-only, matching `ParameterChange`
-- (`20260806000100_parameter_change_append_only`): this log is the review
-- trail for accounts created at runtime, and a trail that can be rewritten is
-- not one.
CREATE TRIGGER `account_definition_change_no_update`
BEFORE UPDATE ON `AccountDefinitionChange`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'AccountDefinitionChange is append-only: UPDATE is not permitted';

CREATE TRIGGER `account_definition_change_no_delete`
BEFORE DELETE ON `AccountDefinitionChange`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'AccountDefinitionChange is append-only: DELETE is not permitted';
