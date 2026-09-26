import { MANAGED_CLIENT_ID_BASE, StoredAccountDefinition } from '../config/account-definition';
import { ExecutionMode } from '../config/execution-mode';
import { LossBasis } from '../risk/risk.config';
import { ChildHandle, ChildSpec, Supervisor, SupervisorTimers } from './supervisor';
import {
  childEnvironment,
  planChildChanges,
  primaryEnvironment,
  restartDelayMs,
  RESTART_MAX_MS,
  STABLE_RUN_MS,
} from './supervisor-plan';

function definition(alias: string, overrides: Partial<StoredAccountDefinition> = {}) {
  return {
    alias,
    label: alias,
    mode: ExecutionMode.PAPER,
    currency: 'USD',
    equity: 100_000,
    symbolCapital: { TQQQ: 25_000 },
    dailyLossThreshold: 3_000,
    dailyLossBasis: LossBasis.REALIZED_AND_UNREALIZED,
    ibAccountId: 'DU7654321',
    ibClientId: MANAGED_CLIENT_ID_BASE,
    port: 3101,
    createdAt: '2026-09-24T10:00:00.000Z',
    ...overrides,
  } satisfies StoredAccountDefinition;
}

const BASE_ENV = {
  ACCOUNT_ALIAS: 'nuuixl118',
  IB_ACCOUNT_ID: 'DU1111111',
  IB_CLIENT_ID: '1',
  IB_HOST: 'host.docker.internal',
  IB_PORT: '4002',
  EXECUTION_MODE: 'PAPER',
  PORT: '3000',
  DATABASE_URL: 'mysql://ib:pw@mysql:3306/ib',
};

describe('supervisor plan', () => {
  it('gives a managed daemon its own identity and the shared database and Gateway', () => {
    const env = childEnvironment(definition('second', { mode: ExecutionMode.LIVE }), BASE_ENV);

    expect(env).toMatchObject({
      ACCOUNT_ALIAS: 'second',
      IB_ACCOUNT_ID: 'DU7654321',
      IB_CLIENT_ID: String(MANAGED_CLIENT_ID_BASE),
      EXECUTION_MODE: 'LIVE',
      PORT: '3101',
      IB_HOST: 'host.docker.internal',
      IB_PORT: '4002',
      DATABASE_URL: BASE_ENV.DATABASE_URL,
    });
    expect(JSON.parse(env.ACCOUNT_DEFINITION ?? '')).toMatchObject({
      alias: 'second',
      allowedModes: ['LIVE'],
    });
  });

  it('never lets the primary’s IB account id reach a managed daemon', () => {
    expect(
      childEnvironment(definition('second', { ibAccountId: null }), BASE_ENV),
    ).not.toHaveProperty('IB_ACCOUNT_ID');
  });

  it('strips a stray ACCOUNT_DEFINITION from the primary', () => {
    expect(primaryEnvironment({ ...BASE_ENV, ACCOUNT_DEFINITION: '{}' })).toEqual(BASE_ENV);
  });

  it('backs off exponentially up to the cap', () => {
    expect(restartDelayMs(1)).toBe(1_000);
    expect(restartDelayMs(2)).toBe(2_000);
    expect(restartDelayMs(4)).toBe(8_000);
    expect(restartDelayMs(100)).toBe(RESTART_MAX_MS);
  });

  it('starts what is new and stops what is gone, keyed by alias', () => {
    const changes = planChildChanges(['a', 'b'], [definition('b'), definition('c')]);

    expect(changes.start.map((d) => d.alias)).toEqual(['c']);
    expect(changes.stop).toEqual(['a']);
  });
});

/** Manually advanced timers: nothing here waits on a real clock. */
class FakeTimers implements SupervisorTimers {
  time = 0;
  private next = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { at: this.time + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  setInterval(): unknown {
    return 'interval';
  }

  clearInterval(): void {}

  advance(ms: number): void {
    this.time += ms;

    for (const [id, timer] of [...this.pending.entries()]) {
      if (timer.at <= this.time) {
        this.pending.delete(id);
        timer.callback();
      }
    }
  }
}

class FakeChild implements ChildHandle {
  readonly signals: string[] = [];
  private listener: ((code: number | null, signal: string | null) => void) | null = null;

  constructor(readonly spec: ChildSpec) {}

  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.listener = listener;
  }

  kill(signal: 'SIGTERM' | 'SIGKILL'): void {
    this.signals.push(signal);
  }

  exit(code: number | null, signal: string | null = null): void {
    this.listener?.(code, signal);
  }
}

function harness(definitions: () => Promise<StoredAccountDefinition[]>) {
  const timers = new FakeTimers();
  const children: FakeChild[] = [];
  const logs: string[] = [];

  const supervisor = new Supervisor({
    env: BASE_ENV,
    spawn: (spec) => {
      const child = new FakeChild(spec);
      children.push(child);
      return child;
    },
    loadDefinitions: definitions,
    logger: {
      log: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
    timers,
    stopGraceMs: 5_000,
  });

  const latest = (name: string) => [...children].reverse().find((c) => c.spec.name === name);

  return { supervisor, timers, children, logs, latest };
}

describe('Supervisor', () => {
  it('runs the primary and every defined account in parallel, each its own process', async () => {
    const { supervisor, children } = harness(async () => [
      definition('second'),
      definition('third', { port: 3102, ibClientId: 13 }),
    ]);

    await supervisor.start();

    expect(children.map((child) => child.spec.name)).toEqual(['nuuixl118', 'second', 'third']);
    expect(children[0].spec.env).toEqual(BASE_ENV);
    expect(children[0].spec.prefixOutput).toBe(false);
    expect(children[2].spec.env.PORT).toBe('3102');
    expect(supervisor.running()).toEqual(['nuuixl118', 'second', 'third']);
  });

  it('picks up an account created after start without disturbing the others', async () => {
    let defined = [definition('second')];
    const { supervisor, children } = harness(async () => defined);

    await supervisor.start();
    defined = [...defined, definition('third', { port: 3102, ibClientId: 13 })];
    await supervisor.sync();

    expect(children.map((child) => child.spec.name)).toEqual(['nuuixl118', 'second', 'third']);
    expect(children.every((child) => child.signals.length === 0)).toBe(true);
  });

  it('restarts a crashed account with backoff, leaving the others alone', async () => {
    const { supervisor, timers, children, latest } = harness(async () => [definition('second')]);
    await supervisor.start();

    latest('second')?.exit(1);
    expect(children).toHaveLength(2);

    timers.advance(999);
    expect(children).toHaveLength(2);
    timers.advance(1);
    expect(children).toHaveLength(3);

    // Second consecutive quick failure waits longer.
    latest('second')?.exit(1);
    timers.advance(1_999);
    expect(children).toHaveLength(3);
    timers.advance(1);
    expect(children).toHaveLength(4);
    expect(children[0].signals).toEqual([]);
  });

  it('resets the backoff after a daemon ran stably', async () => {
    const { supervisor, timers, children, latest } = harness(async () => []);
    await supervisor.start();

    latest('nuuixl118')?.exit(1);
    timers.advance(1_000);
    timers.advance(STABLE_RUN_MS);
    latest('nuuixl118')?.exit(1);
    timers.advance(1_000);

    expect(children).toHaveLength(3);
  });

  it('keeps every daemon running when the registry cannot be read', async () => {
    let fail = false;
    const { supervisor, children, logs } = harness(async () => {
      if (fail) {
        throw new Error('ECONNREFUSED');
      }
      return [definition('second')];
    });

    await supervisor.start();
    fail = true;
    await supervisor.sync();

    expect(children.flatMap((child) => child.signals)).toEqual([]);
    expect(logs.join('\n')).toMatch(/leaving daemons as they are/);
  });

  it('stops a daemon whose account left the registry, and does not restart it', async () => {
    let defined = [definition('second')];
    const { supervisor, timers, children, latest } = harness(async () => defined);
    await supervisor.start();

    defined = [];
    await supervisor.sync();
    expect(latest('second')?.signals).toEqual(['SIGTERM']);

    latest('second')?.exit(null, 'SIGTERM');
    timers.advance(RESTART_MAX_MS);
    expect(children).toHaveLength(2);
    expect(supervisor.running()).toEqual(['nuuixl118']);
  });

  it('names the primary by the default alias when ACCOUNT_ALIAS is unset', async () => {
    const spawned: string[] = [];
    const supervisor = new Supervisor({
      env: { ...BASE_ENV, ACCOUNT_ALIAS: undefined },
      spawn: (spec) => {
        spawned.push(spec.name);
        return new FakeChild(spec);
      },
      loadDefinitions: async () => [definition('nuuixl118')],
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
      timers: new FakeTimers(),
    });

    await supervisor.start();
    expect(spawned).toEqual(['nuuixl118']);
  });

  it('never starts a second daemon for the primary from a registry row', async () => {
    const { supervisor, children } = harness(async () => [definition('nuuixl118')]);
    await supervisor.start();

    expect(children).toHaveLength(1);
  });

  it('runs only the primary without a database', async () => {
    const timers = new FakeTimers();
    const spawned: string[] = [];
    const supervisor = new Supervisor({
      env: BASE_ENV,
      spawn: (spec) => {
        spawned.push(spec.name);
        return new FakeChild(spec);
      },
      loadDefinitions: null,
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
      timers,
    });

    await supervisor.start();
    expect(spawned).toEqual(['nuuixl118']);
  });

  it('stops every daemon on shutdown, killing any that outlast the grace period', async () => {
    const { supervisor, timers, children } = harness(async () => [definition('second')]);
    await supervisor.start();

    const stopped = supervisor.stop();
    children[0].exit(0);
    timers.advance(5_000);
    expect(children[1].signals).toEqual(['SIGTERM', 'SIGKILL']);

    children[1].exit(null, 'SIGKILL');
    await stopped;
    expect(supervisor.running()).toEqual([]);
  });

  it('does not restart a daemon that exits during shutdown', async () => {
    const { supervisor, timers, children } = harness(async () => []);
    await supervisor.start();

    const stopped = supervisor.stop();
    children[0].exit(0);
    await stopped;
    timers.advance(RESTART_MAX_MS);

    expect(children).toHaveLength(1);
  });

  it('retries a daemon that could not be spawned at all', async () => {
    const timers = new FakeTimers();
    let attempts = 0;
    const supervisor = new Supervisor({
      env: BASE_ENV,
      spawn: (spec) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('EAGAIN');
        }
        return new FakeChild(spec);
      },
      loadDefinitions: null,
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
      timers,
    });

    await supervisor.start();
    timers.advance(1_000);

    expect(attempts).toBe(2);
  });
});
