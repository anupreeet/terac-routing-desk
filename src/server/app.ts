// Composition: wire the desk, the simulator (the outside world), the scheduler and HTTP.
// No side effects on import; main.ts and the tests call createApp().
import type { Sql } from './infra/db';
import type { Clock } from './infra/clock';
import type { Logger } from './infra/log';
import { silentLogger } from './infra/log';
import { createDesk } from './commands/desk';
import { createSimulator } from './sim/simulator';
import { SpyChannel, SpyEngine } from './engine/port';
import { createTick } from './scheduler/tick';
import { boot as runBoot, type BootResult } from './scheduler/boot';
import { createViews } from './http/views';
import { createHttp } from './http/routes';
import { POLICY, type Policy } from '../shared/policy';

export interface AppOptions {
  sql: Sql;
  clock: Clock;
  seed?: string;
  log?: Logger;
  policy?: Policy;
  /** 'sim' (default): the simulated engine and contributors answer. 'spy': nothing answers unless a test says so. */
  world?: 'sim' | 'spy';
  /** Called by POST /api/sim/reset after the database is wiped. */
  onReset?: () => void;
  /** Serve the built client from here (production). */
  staticDir?: string;
}

function createCore(opts: AppOptions) {
  const log = opts.log ?? silentLogger;
  const seed = opts.seed ?? '42';
  const policy = opts.policy ?? POLICY;
  const world = opts.world ?? 'sim';

  const sim = world === 'sim' ? createSimulator({ sql: opts.sql, seed, log }) : null;
  const spy = world === 'spy' ? { engine: new SpyEngine(), channel: new SpyChannel() } : null;
  const desk = createDesk({
    sql: opts.sql,
    clock: opts.clock,
    engine: sim ? sim.engine : spy!.engine,
    channel: sim ? sim.channel : spy!.channel,
    log,
    policy,
  });
  sim?.attach(desk);
  const tick = createTick(desk, sim);
  const views = createViews(desk.repo, policy);
  const state = { bootId: 'not-booted', bootedAt: opts.clock.now() };

  const app = {
    sql: opts.sql,
    clock: opts.clock,
    log,
    policy,
    seed,
    desk,
    sim,
    spy,
    views,
    tick: (now = opts.clock.now()) => tick(now),
    boot(now = opts.clock.now()): BootResult {
      const r = runBoot(desk, tick, now);
      state.bootId = r.bootId;
      state.bootedAt = r.bootedAt;
      return r;
    },
    get bootInfo() {
      return { ...state };
    },
    onReset: opts.onReset,
  };
  return app;
}

/** Everything except the HTTP layer (which is built on top of it). */
export type AppCore = ReturnType<typeof createCore>;

export function createApp(opts: AppOptions) {
  const core = createCore(opts);
  return Object.assign(core, { http: createHttp(core, { staticDir: opts.staticDir }) });
}

export type App = ReturnType<typeof createApp>;
