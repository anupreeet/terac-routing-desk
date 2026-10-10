import { describe, expect, it } from 'vitest';
import { POLICY, allowedCommands, isOverdue, nextAutomaticAction, TASK_STATUSES } from '../../src/shared/policy';
import { judge, judgeAll, type ContributorFacts, type Exclusion } from '../../src/server/domain/eligibility';
import { countdown, duration, secs } from '../../src/shared/format';

describe('allowedCommands', () => {
  it('matches the intervention matrix', () => {
    const table = Object.fromEntries(TASK_STATUSES.map((s) => [s, allowedCommands(s)]));
    expect(table).toEqual({
      new: ['submit', 'offer', 'cancel'],
      routing: ['offer', 'reroute', 'stop_routing', 'cancel'],
      offered: ['revoke_offer', 'cancel'],
      assigned: ['release', 'cancel'],
      in_progress: ['cancel'],
      completed: [],
      needs_attention: ['offer', 'reroute', 'cancel'],
      cancelled: [],
    });
  });
});

describe('nextAutomaticAction', () => {
  const asg = { status: 'offered' as const, expiresAt: 5_000, contributorName: 'Ana' };
  it('routing with retries left → retry at the deadline', () => {
    expect(nextAutomaticAction({ status: 'routing', currentAttempt: { retryIndex: 0, deadlineAt: 30_000 }, activeAssignment: null })).toEqual({
      kind: 'retry_routing',
      at: 30_000,
      nextRequest: 2,
      requestsPerRound: 3,
    });
  });
  it('routing on the last request → escalate at the deadline', () => {
    expect(nextAutomaticAction({ status: 'routing', currentAttempt: { retryIndex: 2, deadlineAt: 9 }, activeAssignment: null })).toEqual({ kind: 'escalate_routing', at: 9, requestsPerRound: 3 });
  });
  it('offered → the offer expires', () => {
    expect(nextAutomaticAction({ status: 'offered', currentAttempt: null, activeAssignment: asg })).toEqual({ kind: 'expire_offer', at: 5_000, contributorName: 'Ana' });
  });
  it('everything else waits on a person', () => {
    for (const status of ['new', 'needs_attention', 'assigned', 'in_progress', 'completed', 'cancelled'] as const) {
      expect(nextAutomaticAction({ status, currentAttempt: null, activeAssignment: null })).toBeNull();
    }
  });
  it('Overdue starts at 20 s for every priority, while deadlines differ and high waits least', () => {
    expect(isOverdue(0, 19_999)).toBe(false);
    expect(isOverdue(0, 20_000)).toBe(true);
    const d = POLICY.requestDeadlineMs;
    expect(d.high).toBeLessThan(d.normal);
    expect(d.normal).toBeLessThan(d.low);
    expect(d.high).toBeGreaterThan(POLICY.expectedWindowMs.max);
  });
});

describe('eligibility', () => {
  const base: ContributorFacts = { id: 1, name: 'Ana', availability: 'available', maxActive: 2, load: 0, expertise: ['finance'] };
  const none = new Map<number, Exclusion>();
  it('checks expertise, then availability, then exclusion, then capacity', () => {
    expect(judge(base, 'finance', none).blocker).toBeNull();
    expect(judge(base, 'healthcare', none).blocker).toBe('no_expertise');
    expect(judge({ ...base, availability: 'away', load: 9 }, 'finance', none).blocker).toBe('away');
    const ex = new Map([[1, { contributorId: 1, status: 'declined' as const, at: 1, note: null }]]);
    expect(judge({ ...base, load: 9 }, 'finance', ex).blocker).toBe('excluded');
    expect(judge({ ...base, load: 2 }, 'finance', none).blocker).toBe('at_capacity');
  });
  it('never lists people without the expertise; empty when nobody has it', () => {
    expect(judgeAll([base], 'regulatory', none)).toEqual([]);
    expect(judgeAll([base, { ...base, id: 2, expertise: ['healthcare'] }], 'finance', none)).toHaveLength(1);
  });
});

describe('format', () => {
  it('formats durations and countdowns', () => {
    expect(secs(40_000)).toBe('40.0s');
    expect(duration(8_000)).toBe('8s');
    expect(duration(72_000)).toBe('1m 12s');
    expect(duration(3_725_000)).toBe('1h 2m');
    expect(duration(-5)).toBe('0s');
    expect(countdown(24_001)).toBe('0:25');
    expect(countdown(-1)).toBe('0:00');
  });
});
