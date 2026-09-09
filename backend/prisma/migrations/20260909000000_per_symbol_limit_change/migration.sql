-- CreateTable
CREATE TABLE `PerSymbolLimitChange` (
    `id` VARCHAR(191) NOT NULL,
    `symbol` VARCHAR(32) NOT NULL,
    `oldValue` DECIMAL(18, 6) NULL,
    `newValue` DECIMAL(18, 6) NOT NULL,
    `timestamp` VARCHAR(32) NOT NULL,
    `reason` TEXT NULL,

    INDEX `per_symbol_limit_change_symbol`(`symbol`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Enforce the append-only property at the database level, matching
-- `ParameterChange` (`20260806000100_parameter_change_append_only`). The
-- repository interface already omits `update`/`deleteOne`, but this table IS
-- the audit trail for edits to `RiskConfig.perSymbolLimits`, and an audit
-- trail that can be rewritten is not one.
CREATE TRIGGER `per_symbol_limit_change_no_update`
BEFORE UPDATE ON `PerSymbolLimitChange`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'PerSymbolLimitChange is append-only: UPDATE is not permitted';

CREATE TRIGGER `per_symbol_limit_change_no_delete`
BEFORE DELETE ON `PerSymbolLimitChange`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'PerSymbolLimitChange is append-only: DELETE is not permitted';
