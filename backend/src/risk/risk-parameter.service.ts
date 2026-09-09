/**
 * Live editing of `RiskConfig.perSymbolLimits` — the risk layer's per-symbol
 * capital ceiling (`capital-cap.ts`).
 *
 * ## Why this exists as a separate service from `ParameterService`
 *
 * `ParameterService` edits `DipLadderConfig` — one strategy's own geometry —
 * and deliberately **refuses** `symbolCapital` for a documented reason: it is
 * a Story 13 open item the startup assertion polices, and an HTTP setter would
 * let the dashboard paper over that assertion.
 *
 * A per-symbol *risk* limit is a different fact entirely. It lives on
 * `RiskConfig`, not `DipLadderConfig` — a single object shared across every
 * strategy that trades a symbol, assembled once at boot by `RiskModule` from
 * `capital.config.ts`. Unlike `symbolCapital`, nothing refuses it structurally;
 * it is absent from the runtime-editable ladder surface only because it does
 * not belong to the ladder in the first place. This service is where it is
 * edited instead, following the same three-step shape `ParameterService` uses
 * — validate, record, apply — because the operational need is identical: an
 * operator watching orders get rejected against a ceiling that no longer
 * matches the account's real capital needs to move that ceiling without a
 * restart, with a record of who changed what and when.
 *
 * ## Why this mutates `RiskConfig` in place
 *
 * `RISK_CONFIG` is a single Nest-managed singleton, injected into
 * `RiskManagerService` once at construction and read fresh on every
 * `applyCapitalCap` call (`capital-cap.ts:78`, `config.perSymbolLimits[symbol]`
 * — not cached). Mutating the same object instance this service is given, in
 * place, is what makes an edit take effect immediately, exactly the trick
 * `ParameterService` already relies on for `DipLadderConfig`.
 *
 * ## Why the audit trail is a separate table
 *
 * See `PerSymbolLimitChangeRepository` for why this is not a row in
 * `ParameterChange`.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { RiskConfig } from './risk.config';
import { RISK_CONFIG } from './risk.module';
import {
  PER_SYMBOL_LIMIT_CHANGE_REPOSITORY,
  PerSymbolLimitChange,
  PerSymbolLimitChangeRepository,
} from '../repositories/repository.interfaces';

export class RiskParameterEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RiskParameterEditError';
  }
}

export interface PerSymbolLimitEditResult {
  symbol: string;
  oldValue: number | null;
  newValue: number;
  /** False when the requested value matched the current one — no record written. */
  changed: boolean;
}

@Injectable()
export class RiskParameterService {
  private readonly logger = new Logger(RiskParameterService.name);
  private changeSequence = 0;

  constructor(
    @Inject(RISK_CONFIG) private readonly config: RiskConfig,
    @Inject(PER_SYMBOL_LIMIT_CHANGE_REPOSITORY)
    private readonly changes: PerSymbolLimitChangeRepository,
  ) {}

  /** Current limits, keyed by symbol. A symbol absent here is unconstrained by this control. */
  current(): Record<string, number> {
    return { ...this.config.perSymbolLimits };
  }

  /**
   * Re-applies the latest recorded limit per symbol onto the live `RiskConfig`,
   * from the append-only audit log.
   *
   * **Without this, a restart silently discards every runtime edit** — the
   * same failure mode `ParameterService.restore` exists to close, for the same
   * reason: `RISK_CONFIG` is rebuilt from `capital.config.ts` on every boot,
   * and nothing else reads this history back.
   *
   * Called once at boot, before any bar can reach the risk manager — mirroring
   * where `ParameterService.restore` sits in `EngineModule`'s startup chain,
   * just for this config instead. Non-fatal: a recorded value that is no
   * longer valid (e.g. now non-positive) is logged and skipped, leaving the
   * compiled default in force for that symbol rather than blocking the boot.
   */
  async restore(): Promise<void> {
    const history = await this.changes.findAll();

    // Bump the in-memory id counter past every sequence number seen in
    // history, the same way `ParameterService.restore` does for
    // `param-change-N` — only ever raised, never lowered, so a fresh edit
    // cannot collide with an id a prior process lifetime already wrote.
    for (const change of history) {
      const match = /^risk-limit-change-(\d+)$/.exec(change.id);

      if (match) {
        this.changeSequence = Math.max(this.changeSequence, Number(match[1]));
      }
    }

    if (history.length === 0) {
      return;
    }

    // Append-only, so the latest record per symbol is the effective value.
    const latest = new Map<string, PerSymbolLimitChange>();

    for (const change of history) {
      const existing = latest.get(change.symbol);

      if (!existing || change.timestamp >= existing.timestamp) {
        latest.set(change.symbol, change);
      }
    }

    const applied: string[] = [];

    for (const [symbol, change] of latest) {
      if (!Number.isFinite(change.newValue) || change.newValue <= 0) {
        this.logger.error(
          `could not restore the per-symbol limit for ${symbol} from history — ` +
            `${change.newValue} is no longer valid, leaving the compiled default in force`,
        );
        continue;
      }

      this.config.perSymbolLimits[symbol] = change.newValue;
      applied.push(`${symbol}=${change.newValue}`);
    }

    if (applied.length > 0) {
      this.logger.log(`restored per-symbol risk limit(s) from history: ${applied.join(', ')}`);
    }
  }

  /**
   * Applies an edit and returns what changed.
   *
   * Validate, then record, then apply — the same order `ParameterService.edit`
   * uses, for the same reason: a rejected edit must leave no trace in the
   * audit log and no partial write in the config.
   */
  async edit(params: {
    symbol: string;
    limit: number;
    timestamp: string;
    reason?: string | null;
  }): Promise<PerSymbolLimitEditResult> {
    const { symbol, timestamp } = params;

    if (!symbol || typeof symbol !== 'string') {
      throw new RiskParameterEditError('symbol must be a non-empty string');
    }

    if (!Number.isFinite(params.limit) || params.limit <= 0) {
      throw new RiskParameterEditError(`limit must be a positive number, got ${params.limit}`);
    }

    const oldValue = this.config.perSymbolLimits[symbol] ?? null;
    const newValue = params.limit;

    if (oldValue === newValue) {
      return { symbol, oldValue, newValue, changed: false };
    }

    const change: PerSymbolLimitChange = {
      id: `risk-limit-change-${(this.changeSequence += 1)}`,
      symbol,
      oldValue,
      newValue,
      timestamp,
      reason: params.reason ?? null,
    };

    await this.changes.append(change);

    // Apply by mutating the object `RiskManagerService` holds — see the file
    // comment for why this is what makes the edit take effect immediately.
    this.config.perSymbolLimits[symbol] = newValue;

    this.logger.log(
      `per-symbol risk limit for ${symbol} updated: ${oldValue ?? '(unconstrained)'} → ${newValue}` +
        (change.reason ? ` — ${change.reason}` : ''),
    );

    return { symbol, oldValue, newValue, changed: true };
  }
}
