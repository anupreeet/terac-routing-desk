// The simulated engine follows the brief: ~20% never answer, answers usually in 5–20 s.
import { describe, expect, it } from 'vitest';
import { planFate, SIM_PARAMS } from '../../src/server/sim/fate';
import type { DispatchRequest } from '../../src/server/engine/port';

const req = (taskId: number, seq = 1, candidates = 3): DispatchRequest => ({
  attemptId: taskId * 10 + seq,
  taskId,
  seq,
  expertiseId: 'finance',
  expertiseLabel: 'Finance',
  priority: 'normal',
  candidates: Array.from({ length: candidates }, (_, i) => ({ contributorId: i + 1, name: `C${i + 1}`, load: i, maxActive: 3 })),
  dispatchedAt: 0,
});

describe('planFate (realistic)', () => {
  const N = 5_000;
  const fates = Array.from({ length: N }, (_, i) => planFate('42', req(1000 + i), 'realistic'));

  it('about 20% of requests never answer', () => {
    const never = fates.filter((f) => f.dueInMs === null).length / N;
    expect(never).toBeGreaterThan(SIM_PARAMS.neverReturnRate - 0.02);
    expect(never).toBeLessThan(SIM_PARAMS.neverReturnRate + 0.02);
  });

  it('answers land in 5–20 s, except a ~10% slow tail of 20–90 s', () => {
    const answered = fates.filter((f) => f.dueInMs !== null).map((f) => f.dueInMs!);
    expect(Math.min(...answered)).toBeGreaterThanOrEqual(5_000);
    expect(Math.max(...answered)).toBeLessThanOrEqual(90_000);
    const slow = answered.filter((ms) => ms > 20_000).length / answered.length;
    expect(slow).toBeGreaterThan(0.07);
    expect(slow).toBeLessThan(0.13);
  });

  it('is deterministic per (seed, task, request) and independent of order', () => {
    expect(planFate('42', req(7, 2), 'realistic')).toEqual(planFate('42', req(7, 2), 'realistic'));
    expect(planFate('42', req(7, 2), 'realistic')).not.toEqual(planFate('43', req(7, 2), 'realistic'));
  });

  it('reports no match when nobody was sent, whatever the dice say', () => {
    for (let i = 0; i < 50; i++) expect(planFate('42', req(i, 1, 0), 'realistic').result.kind).toBe('no_match');
  });

  it('picks the lowest load ratio and explains why', () => {
    const f = planFate('42', req(1, 1, 3), 'quick_match');
    expect(f.result).toEqual({ kind: 'match', contributorId: 1, reason: 'Lowest current load among 3 eligible Finance contributors (C1: 0 of 3 active).' });
  });
});

describe('presets', () => {
  it('follow their scripts', () => {
    expect(planFate('x', req(1, 1), 'lost_always').dueInMs).toBeNull();
    expect(planFate('x', req(1, 1), 'lost_once').dueInMs).toBeNull();
    expect(planFate('x', req(1, 2), 'lost_once').dueInMs).toBe(6_000);
    expect(planFate('x', req(1, 1), 'late_answer').dueInMs).toBe(40_000);
    expect(planFate('x', req(1, 1), 'no_match').result.kind).toBe('no_match');
    expect(planFate('x', req(1, 2), 'no_match').result.kind).toBe('match');
  });
});
