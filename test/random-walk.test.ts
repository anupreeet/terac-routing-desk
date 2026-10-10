// A seeded random walk: hundreds of interleaved operator commands (often with stale versions),
// contributor replies, engine deliveries (including late, duplicate and ineligible ones),
// availability flips and clock jumps. After EVERY step all invariants must hold, rejected actions
// must change nothing, late answers must never be applied, and final states must stay final.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness';
import { mulberry32 } from '../src/server/infra/rng';
import { DomainError } from '../src/server/domain/errors';
import { CONTRIBUTOR_ACTIONS, isFinal, type ContributorAction } from '../src/shared/policy';
import type { ParsedCommand } from '../src/shared/schemas';

let h: Harness;
afterEach(() => h?.close());

const FIXTURE = {
  expertise: [
    { id: 'finance', label: 'Finance' },
    { id: 'healthcare', label: 'Healthcare' },
  ],
  contributors: [
    { id: 1, name: 'Ana Ortiz', expertise: ['finance'], maxActive: 1 },
    { id: 2, name: 'Ben Hale', expertise: ['finance', 'healthcare'], maxActive: 2 },
    { id: 3, name: 'Chen Wei', expertise: ['healthcare'], maxActive: 1 },
  ],
};

function walk(seed: number, steps: number) {
  h = createHarness({ world: 'sim', seed: `walk-${seed}`, fixture: FIXTURE });
  const rnd = mulberry32(seed);
  const pickOf = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const tasks: number[] = [];
  const finalSeen = new Map<number, string>();
  const engines = ['realistic', 'quick_match', 'late_answer', 'lost_once', 'lost_always', 'no_match'] as const;
  const people = ['manual', 'accept', 'decline', 'ignore', 'withdraw_after_accept'] as const;

  for (let i = 0; i < steps; i++) {
    const roll = rnd();
    const snapshotOf = (id: number) => JSON.stringify({ t: h.task(id), a: h.repo.assignmentsForTask(id), r: h.attempts(id).map((x) => ({ ...x, resultAt: null, resultKind: null, resultContributorId: null, resultReason: null })) });

    if (roll < 0.15 || tasks.length === 0) {
      tasks.push(h.create({ expertiseId: pickOf(['finance', 'healthcare']), priority: pickOf(['high', 'normal', 'low'] as const), submit: rnd() < 0.8, engine: pickOf(engines), contributor: pickOf(people) }));
    } else if (roll < 0.45) {
      const id = pickOf(tasks);
      const t = h.task(id);
      const type = pickOf(['submit', 'offer', 'reroute', 'stop_routing', 'revoke_offer', 'release', 'cancel'] as const);
      const stale = rnd() < 0.2;
      const cmd = { type, expectedVersion: stale ? t.version - 1 : t.version, contributorId: pickOf([1, 2, 3]), acknowledgeExclusion: rnd() < 0.5, note: 'walk' } as ParsedCommand;
      const before = snapshotOf(id);
      try {
        h.app.desk.command(id, cmd);
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        expect(snapshotOf(id), `rejected ${type} changed T-${id}`).toBe(before);
      }
    } else if (roll < 0.6) {
      const id = pickOf(tasks);
      const asg = h.repo.assignmentsForTask(id).at(-1);
      if (asg) {
        const action: ContributorAction = pickOf(CONTRIBUTOR_ACTIONS);
        try {
          h.app.desk.respond(asg.id, action, { note: 'walk' });
        } catch (err) {
          if (!(err instanceof DomainError)) throw err;
        }
      }
    } else if (roll < 0.7) {
      // Deliver an answer for any request, current or not, with any contributor.
      const id = pickOf(tasks);
      const a = h.attempts(id);
      if (a.length) {
        const target = pickOf(a);
        const before = snapshotOf(id);
        const wasLive = target.status === 'pending' && h.task(id).currentAttemptId === target.id && h.task(id).status === 'routing';
        const r = h.app.desk.applyEngineResult(target.id, rnd() < 0.85 ? { kind: 'match', contributorId: pickOf([1, 2, 3]) } : { kind: 'no_match' }, h.clock.now());
        if (!wasLive) {
          expect(r.applied, `late answer applied on T-${id}`).toBe(false);
          if (r.reason === 'late' || r.reason === 'duplicate') expect(snapshotOf(id)).toBe(before);
        }
      }
    } else if (roll < 0.75) {
      h.app.desk.setAvailability(pickOf([1, 2, 3]), rnd() < 0.5 ? 'away' : 'available');
    } else {
      h.advance(pickOf([0, 500, 5_000, 20_000, 31_000, 61_000]));
    }
    h.app.tick();
    h.assertInvariants();

    // Liveness: after a tick nothing is overdue for enforcement.
    const now = h.clock.now();
    expect(h.repo.duePendingAttemptIds(now)).toEqual([]);
    expect(h.repo.dueOfferIds(now)).toEqual([]);
    // Final states are absorbing.
    for (const id of tasks) {
      const s = h.task(id).status;
      if (finalSeen.has(id)) expect(s, `T-${id} left a final state`).toBe(finalSeen.get(id));
      else if (isFinal(s)) finalSeen.set(id, s);
    }
  }
  return { tasks: tasks.length, final: finalSeen.size };
}

describe('seeded random walk', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`seed ${seed}: 400 random steps keep every invariant`, () => {
      const r = walk(seed, 400);
      expect(r.tasks).toBeGreaterThan(10);
    });
  }
});
