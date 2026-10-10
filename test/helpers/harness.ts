// Test harness: a real app on a real SQLite database, driven by a FakeClock. Every step of time
// runs the scheduler and then checks every invariant, so a broken promise fails at the exact step.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { openDb, type Sql } from '../../src/server/infra/db';
import { FakeClock } from '../../src/server/infra/clock';
import { createApp, type App } from '../../src/server/app';
import { createRepo } from '../../src/server/store/repo';
import { checkInvariants } from '../../src/server/infra/invariants';
import type { DistributiveOmit, ParsedCommand } from '../../src/shared/schemas';
import type { Priority } from '../../src/shared/policy';
import type { EnginePreset, ContributorPreset } from '../../src/shared/sim-presets';
import type { EngineResult } from '../../src/server/engine/port';

export const T0 = Date.UTC(2026, 9, 4, 14, 0, 0);
export const S = 1_000;

export const FIXTURE = {
  expertise: [
    { id: 'finance', label: 'Finance' },
    { id: 'healthcare', label: 'Healthcare' },
    { id: 'regulatory', label: 'Regulatory affairs' },
  ],
  contributors: [
    { id: 1, name: 'Ana Ortiz', expertise: ['finance'], maxActive: 1 },
    { id: 2, name: 'Ben Hale', expertise: ['finance'], maxActive: 1 },
    { id: 3, name: 'Chen Wei', expertise: ['healthcare'], maxActive: 2 },
  ],
};
export const ANA = 1;
export const BEN = 2;
export const CHEN = 3;

export interface Harness {
  app: App;
  clock: FakeClock;
  sql: Sql;
  repo: ReturnType<typeof createRepo>;
  http: ReturnType<typeof request>;
  /** Advance time in 500 ms ticks, running the scheduler and checking invariants after each tick. */
  advance(ms: number): void;
  /** Jump time in one step, then one tick (as if the process slept). */
  jump(ms: number): void;
  /** Create (and by default submit) a task; returns its id. */
  create(o?: { title?: string; expertiseId?: string; priority?: Priority; submit?: boolean; engine?: EnginePreset; contributor?: ContributorPreset }): number;
  /** Run an operator command with the task's current version. */
  cmd(taskId: number, c: DistributiveOmit<ParsedCommand, 'expectedVersion'> & { expectedVersion?: number }): void;
  task(id: number): NonNullable<ReturnType<ReturnType<typeof createRepo>['getTask']>>;
  types(taskId: number): string[];
  attempts(taskId: number): ReturnType<ReturnType<typeof createRepo>['attemptsForTask']>;
  active(taskId: number): ReturnType<ReturnType<typeof createRepo>['activeAssignment']>;
  /** Deliver an engine answer for the task's request #seq right now (spy world). */
  deliver(taskId: number, seq: number, r: EngineResult): ReturnType<App['desk']['applyEngineResult']>;
  respond(taskId: number, action: 'accept' | 'decline' | 'start' | 'withdraw' | 'complete', note?: string): ReturnType<App['desk']['respond']>;
  /** Close the database and start a brand-new app on the same file at `at`, running boot catch-up. */
  restart(at: number): Harness;
  assertInvariants(): void;
  close(): void;
}

export function createHarness(opts: { world?: 'sim' | 'spy'; seed?: string; file?: boolean; startAt?: number; fixture?: typeof FIXTURE; _path?: string; _dir?: string } = {}): Harness {
  const world = opts.world ?? 'sim';
  const dir = opts._dir ?? (opts.file ? mkdtempSync(join(tmpdir(), 'desk-test-')) : null);
  const path = opts._path ?? (dir ? join(dir, 'desk.sqlite') : ':memory:');
  const sql = openDb(path);
  const clock = new FakeClock(opts.startAt ?? T0);
  const app = createApp({ sql, clock, world, seed: opts.seed ?? 'test' });
  const repo = createRepo(sql);
  const fixture = opts.fixture ?? FIXTURE;

  if (!opts._path) {
    sql.tx(() => {
      fixture.expertise.forEach((e, i) => repo.insertExpertise(e.id, e.label, i));
      for (const c of fixture.contributors) {
        repo.insertContributor({ id: c.id, name: c.name, headline: '', availability: 'available', maxActive: c.maxActive, expertise: c.expertise, now: clock.now() });
      }
    });
  }
  app.boot();

  const assertInvariants = () => {
    const v = checkInvariants(sql);
    if (v.length) throw new Error(`Invariant violated at t=+${(clock.now() - T0) / 1000}s:\n${v.map((x) => `  ${x.rule}: ${x.detail}`).join('\n')}`);
  };

  const h: Harness = {
    app,
    clock,
    sql,
    repo,
    http: request(app.http),
    advance(ms) {
      let left = ms;
      while (left > 0) {
        const step = Math.min(500, left);
        clock.advance(step);
        left -= step;
        app.tick();
        assertInvariants();
      }
    },
    jump(ms) {
      clock.advance(ms);
      app.tick();
      assertInvariants();
    },
    create(o = {}) {
      const t = app.desk.createTask(
        { title: o.title ?? 'Test task', expertiseId: o.expertiseId ?? 'finance', priority: o.priority ?? 'normal' },
        { submit: o.submit ?? true, onCreated: app.sim ? (id) => app.sim!.setScenario(id, o.engine ?? 'realistic', o.contributor ?? 'manual') : undefined },
      );
      assertInvariants();
      return t.id;
    },
    cmd(taskId, c) {
      app.tick();
      app.desk.command(taskId, { ...c, expectedVersion: c.expectedVersion ?? repo.getTask(taskId)!.version } as ParsedCommand);
      assertInvariants();
    },
    task: (id) => repo.getTask(id)!,
    types: (taskId) => repo.eventsForTask(taskId).map((e) => e.type),
    attempts: (taskId) => repo.attemptsForTask(taskId),
    active: (taskId) => repo.activeAssignment(taskId),
    deliver(taskId, seq, r) {
      const a = repo.attemptsForTask(taskId).find((x) => x.seq === seq);
      if (!a) throw new Error(`T-${taskId} has no request #${seq}`);
      const out = app.desk.applyEngineResult(a.id, r, clock.now());
      assertInvariants();
      return out;
    },
    respond(taskId, action, note) {
      const asg = repo.activeAssignment(taskId) ?? repo.lastAssignment(taskId);
      if (!asg) throw new Error(`T-${taskId} has no assignment`);
      const out = app.desk.respond(asg.id, action, { note });
      assertInvariants();
      return out;
    },
    restart(at) {
      sql.close();
      clock.set(at);
      const next = createHarness({ ...opts, startAt: at, _path: path, _dir: dir ?? undefined });
      return next;
    },
    assertInvariants,
    close() {
      try {
        sql.close();
      } catch {
        /* already closed */
      }
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}
