/**
 * Runs one trading daemon per account, in parallel, inside one container.
 *
 * `docs/decisions/accounts.md` chose **a process per account** so that a crash,
 * a stuck timer, or a halt in one account cannot reach another. Dashboard-created
 * accounts keep that property: each is a full, separate `main.js` process with
 * its own engine, risk manager, kill switch, and IB session. The supervisor only
 * starts, restarts, and stops them — it holds no trading state, reads no
 * positions, and has no path to a broker.
 *
 * - **The primary daemon** is the account the container was configured with
 *   (`ACCOUNT_ALIAS`, `nuuixl118` by default), started with the container's
 *   environment unchanged, so it behaves exactly as it did before this existed.
 * - **Managed daemons** are the rows in `AccountDefinition`, re-read every
 *   `pollMs` so an account created from the dashboard starts without a restart.
 *
 * Every daemon is restarted when it exits, with backoff. Compose's `restart`
 * policy watches only the container — this process — so without this a crashed
 * account would stay down while every health signal for the container read fine.
 */

import { StoredAccountDefinition } from '../config/account-definition';
import { activeAccountAlias } from '../config/accounts.config';
import {
  childEnvironment,
  planChildChanges,
  primaryEnvironment,
  restartDelayMs,
  STABLE_RUN_MS,
} from './supervisor-plan';

type Env = Record<string, string | undefined>;

export interface ChildSpec {
  /** The account alias, used for log prefixes and bookkeeping. */
  name: string;
  env: Env;
  /** False for the primary, whose output is passed through unchanged. */
  prefixOutput: boolean;
}

export interface ChildHandle {
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

export interface SupervisorLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface SupervisorTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface SupervisorOptions {
  env: Env;
  spawn(spec: ChildSpec): ChildHandle;
  /** Null without `DATABASE_URL`: only the primary runs. */
  loadDefinitions: (() => Promise<StoredAccountDefinition[]>) | null;
  logger: SupervisorLogger;
  timers?: SupervisorTimers;
  pollMs?: number;
  /** How long `stop()` waits for a daemon to exit before killing it. */
  stopGraceMs?: number;
}

interface ManagedChild {
  spec: ChildSpec;
  handle: ChildHandle | null;
  startedAt: number;
  failures: number;
  restartTimer: unknown;
  /** False once the account left the registry, or the supervisor is stopping. */
  wanted: boolean;
  exited: Promise<void>;
  markExited: () => void;
}

export const DEFAULT_POLL_MS = 10_000;
export const DEFAULT_STOP_GRACE_MS = 10_000;

const realTimers: SupervisorTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export class Supervisor {
  private readonly children = new Map<string, ManagedChild>();
  private readonly timers: SupervisorTimers;
  private readonly pollMs: number;
  private readonly stopGraceMs: number;
  private pollHandle: unknown = null;
  private syncing: Promise<void> | null = null;
  private stopping = false;
  private primaryName = '';

  constructor(private readonly options: SupervisorOptions) {
    this.timers = options.timers ?? realTimers;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  }

  /** Starts the primary daemon, then every managed account. */
  async start(): Promise<void> {
    const env = primaryEnvironment(this.options.env);
    // The same resolution the daemon applies, so an unset ACCOUNT_ALIAS names
    // the default account here too — which is what the guard against a
    // registry row reusing the primary's alias compares against.
    this.primaryName = activeAccountAlias(env);
    this.launch({ name: this.primaryName, env, prefixOutput: false });

    if (this.options.loadDefinitions === null) {
      this.options.logger.log(
        'no DATABASE_URL — running the primary account only; dashboard-created accounts need MySQL',
      );
      return;
    }

    await this.sync();
    this.pollHandle = this.timers.setInterval(() => void this.sync(), this.pollMs);
  }

  /** The aliases with a daemon wanted right now. For status and tests. */
  running(): string[] {
    return [...this.children.entries()].filter(([, child]) => child.wanted).map(([name]) => name);
  }

  /**
   * Matches running daemons to the registry.
   *
   * A failed read changes nothing: "could not ask the database" is not "no
   * accounts", and stopping every managed daemon on a database blip would turn
   * a read error into an outage across every account.
   */
  async sync(): Promise<void> {
    if (this.syncing !== null) {
      return this.syncing;
    }

    this.syncing = this.syncOnce().finally(() => {
      this.syncing = null;
    });

    return this.syncing;
  }

  private async syncOnce(): Promise<void> {
    const load = this.options.loadDefinitions;

    if (load === null || this.stopping) {
      return;
    }

    let definitions: StoredAccountDefinition[];

    try {
      definitions = await load();
    } catch (error) {
      this.options.logger.warn(
        `could not read account definitions; leaving daemons as they are: ${describe(error)}`,
      );
      return;
    }

    if (this.stopping) {
      return;
    }

    // The primary is never in the registry (the controller refuses code
    // aliases), but a hand-inserted row naming it must not start a second
    // daemon for the same account.
    const managed = definitions.filter((definition) => definition.alias !== this.primaryName);
    const running = this.running().filter((name) => name !== this.primaryName);
    const changes = planChildChanges(running, managed);

    for (const definition of changes.start) {
      // Still shutting down after leaving the registry: starting it again now
      // would put two daemons on one port and one IB client id.
      if (this.children.has(definition.alias)) {
        continue;
      }

      this.options.logger.log(
        `starting account "${definition.alias}" (${definition.mode}) on port ${definition.port}, IB client id ${definition.ibClientId}`,
      );
      this.launch({
        name: definition.alias,
        env: childEnvironment(definition, this.options.env),
        prefixOutput: true,
      });
    }

    for (const name of changes.stop) {
      this.options.logger.warn(`account "${name}" is no longer defined; stopping its daemon`);
      void this.retire(name);
    }
  }

  /**
   * Stops every daemon and waits for each to exit, killing any that outlast the
   * grace period. Stopping a daemon never touches its positions — that is the
   * same as the container stopping today.
   */
  async stop(): Promise<void> {
    this.stopping = true;

    if (this.pollHandle !== null) {
      this.timers.clearInterval(this.pollHandle);
      this.pollHandle = null;
    }

    const exits = [...this.children.keys()].map((name) => this.retire(name));
    await Promise.all(exits);
  }

  private launch(spec: ChildSpec): void {
    const existing = this.children.get(spec.name);
    let markExited: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });

    const child: ManagedChild = existing ?? {
      spec,
      handle: null,
      startedAt: 0,
      failures: 0,
      restartTimer: null,
      wanted: true,
      exited,
      markExited,
    };

    child.spec = spec;
    child.wanted = true;
    child.restartTimer = null;
    child.exited = exited;
    child.markExited = markExited;
    this.children.set(spec.name, child);

    let handle: ChildHandle;

    try {
      handle = this.options.spawn(spec);
    } catch (error) {
      this.options.logger.error(`could not start "${spec.name}": ${describe(error)}`);
      child.markExited();
      this.scheduleRestart(child);
      return;
    }

    child.handle = handle;
    child.startedAt = this.timers.now();
    handle.onExit((code, signal) => this.onExit(child, handle, code, signal));
  }

  private onExit(
    child: ManagedChild,
    handle: ChildHandle,
    code: number | null,
    signal: string | null,
  ): void {
    if (child.handle !== handle) {
      return;
    }

    child.handle = null;
    child.markExited();

    const how = signal === null ? `code ${String(code)}` : `signal ${signal}`;

    if (!child.wanted || this.stopping) {
      this.options.logger.log(`account "${child.spec.name}" stopped (${how})`);
      this.children.delete(child.spec.name);
      return;
    }

    if (this.timers.now() - child.startedAt >= STABLE_RUN_MS) {
      child.failures = 0;
    }

    this.options.logger.error(`account "${child.spec.name}" exited (${how})`);
    this.scheduleRestart(child);
  }

  private scheduleRestart(child: ManagedChild): void {
    if (!child.wanted || this.stopping) {
      return;
    }

    child.failures += 1;
    const delay = restartDelayMs(child.failures);
    this.options.logger.warn(
      `restarting account "${child.spec.name}" in ${Math.round(delay / 1000)}s (attempt ${child.failures})`,
    );

    child.restartTimer = this.timers.setTimeout(() => {
      child.restartTimer = null;

      if (child.wanted && !this.stopping) {
        this.launch(child.spec);
      }
    }, delay);
  }

  private retire(name: string): Promise<void> {
    const child = this.children.get(name);

    if (child === undefined) {
      return Promise.resolve();
    }

    child.wanted = false;

    if (child.restartTimer !== null) {
      this.timers.clearTimeout(child.restartTimer);
      child.restartTimer = null;
    }

    const handle = child.handle;

    if (handle === null) {
      this.children.delete(name);
      return Promise.resolve();
    }

    handle.kill('SIGTERM');

    const escalation = this.timers.setTimeout(() => {
      if (child.handle === handle) {
        this.options.logger.warn(`account "${name}" did not exit; killing it`);
        handle.kill('SIGKILL');
      }
    }, this.stopGraceMs);

    return child.exited.then(() => this.timers.clearTimeout(escalation));
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
