// The desk's rules as pure functions: the intervention matrix, finality, the Overdue label, the
// retry budget and "what happens next". Server, UI and tests all read these, so they are pinned here.
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_ASSIGNMENT_STATUSES,
  ASSIGNMENT_STATUSES,
  ATTENTION_REASONS,
  CONTRIBUTOR_ACTIONS,
  EXCLUDING_ASSIGNMENT_STATUSES,
  FINAL_STATUSES,
  OPERATOR_COMMANDS,
  POLICY,
  PRIORITIES,
  TASK_STATUSES,
  allowedCommands,
  isFinal,
  isOverdue,
  nextAutomaticAction,
  requestsPerRound,
  type AssignmentStatus,
  type OperatorCommand,
  type Policy,
  type TaskStatus,
} from '../../src/shared/policy';

const policyWith = (o: Partial<Policy>): Policy => ({ ...POLICY, ...o });

describe('glossary: the exact names CLAUDE.md promises', () => {
  it('task statuses', () => {
    expect([...TASK_STATUSES]).toEqual(['new', 'routing', 'offered', 'assigned', 'in_progress', 'completed', 'needs_attention', 'cancelled']);
  });
  it('attention reasons are things that happened TO the task (no operator-initiated reasons)', () => {
    expect([...ATTENTION_REASONS]).toEqual(['no_eligible_contributors', 'no_match', 'routing_exhausted', 'declined', 'offer_expired', 'failed_before_start']);
    expect(ATTENTION_REASONS).not.toContain('offer_revoked');
    expect(ATTENTION_REASONS).not.toContain('routing_stopped');
  });
  it('operator commands and contributor actions', () => {
    expect([...OPERATOR_COMMANDS]).toEqual(['submit', 'offer', 'reroute', 'stop_routing', 'revoke_offer', 'release', 'cancel']);
    expect([...CONTRIBUTOR_ACTIONS]).toEqual(['accept', 'decline', 'start', 'withdraw', 'complete']);
  });
  it('active and excluding assignment statuses are disjoint subsets of all assignment statuses', () => {
    for (const s of [...ACTIVE_ASSIGNMENT_STATUSES, ...EXCLUDING_ASSIGNMENT_STATUSES]) expect(ASSIGNMENT_STATUSES).toContain(s);
    expect(ACTIVE_ASSIGNMENT_STATUSES.filter((s) => EXCLUDING_ASSIGNMENT_STATUSES.includes(s))).toEqual([]);
    expect([...ACTIVE_ASSIGNMENT_STATUSES]).toEqual(['offered', 'accepted', 'in_progress']);
  });
  it('R8: declined, expired, withdrawn and released exclude; revoked, cancelled and completed say nothing about the person', () => {
    expect([...EXCLUDING_ASSIGNMENT_STATUSES].sort()).toEqual(['declined', 'expired', 'released', 'withdrawn']);
    for (const s of ['revoked', 'cancelled', 'completed'] as AssignmentStatus[]) expect(EXCLUDING_ASSIGNMENT_STATUSES).not.toContain(s);
  });
});

describe('allowedCommands(status): the intervention matrix (PLAN §5.7 + amendment A1)', () => {
  const MATRIX: Record<TaskStatus, OperatorCommand[]> = {
    new: ['submit', 'offer', 'cancel'],
    routing: ['offer', 'reroute', 'stop_routing', 'cancel'],
    offered: ['revoke_offer', 'cancel'],
    assigned: ['release', 'cancel'],
    in_progress: ['cancel'],
    completed: [],
    needs_attention: ['offer', 'reroute', 'cancel'],
    cancelled: [],
  };

  it.each(TASK_STATUSES.map((s) => [s, MATRIX[s]] as const))('%s → %j', (status, cmds) => {
    expect(allowedCommands(status)).toEqual(cmds);
  });

  it.each(TASK_STATUSES.filter((s) => !isFinal(s)))('%s: cancel is always available while the task is open', (status) => {
    expect(allowedCommands(status)).toContain('cancel');
  });

  it('submit only from Not routed; stop_routing only while routing; revoke only while offered; release only while assigned', () => {
    const where = (c: OperatorCommand) => TASK_STATUSES.filter((s) => allowedCommands(s).includes(c));
    expect(where('submit')).toEqual(['new']);
    expect(where('stop_routing')).toEqual(['routing']);
    expect(where('revoke_offer')).toEqual(['offered']);
    expect(where('release')).toEqual(['assigned']);
    expect(where('reroute')).toEqual(['routing', 'needs_attention']);
    expect(where('offer')).toEqual(['new', 'routing', 'needs_attention']);
  });

  it('no direct offer while someone is engaged: the operator must revoke or release first (R1)', () => {
    for (const s of ['offered', 'assigned', 'in_progress'] as TaskStatus[]) expect(allowedCommands(s)).not.toContain('offer');
  });

  it('every operator command is reachable from some status', () => {
    const reachable = new Set(TASK_STATUSES.flatMap((s) => allowedCommands(s)));
    expect([...reachable].sort()).toEqual([...OPERATOR_COMMANDS].sort());
  });

  it('returns a fresh array each time, so a caller cannot corrupt the matrix', () => {
    const a = allowedCommands('new');
    a.push('release');
    expect(allowedCommands('new')).toEqual(['submit', 'offer', 'cancel']);
  });
});

describe('isFinal(status)', () => {
  it.each(TASK_STATUSES.map((s) => [s, s === 'completed' || s === 'cancelled'] as const))('%s → %s', (status, final) => {
    expect(isFinal(status)).toBe(final);
  });
  it('final statuses are exactly the ones with no commands', () => {
    expect([...FINAL_STATUSES].sort()).toEqual(TASK_STATUSES.filter((s) => allowedCommands(s).length === 0).sort());
  });
});

describe('isOverdue(dispatchedAt, now): a label at 20 s, the same for every priority', () => {
  const t0 = 1_000_000;
  it.each([
    [0, false],
    [1, false],
    [POLICY.overdueAfterMs - 1, false],
    [POLICY.overdueAfterMs, true],
    [POLICY.overdueAfterMs + 1, true],
    [10 * POLICY.overdueAfterMs, true],
  ])('%i ms after dispatch → %s', (elapsed, overdue) => {
    expect(isOverdue(t0, t0 + elapsed)).toBe(overdue);
  });
  it('a clock that reads earlier than the dispatch is not overdue', () => {
    expect(isOverdue(t0, t0 - 60_000)).toBe(false);
  });
  it('honours a custom policy', () => {
    expect(isOverdue(0, 5_000, policyWith({ overdueAfterMs: 5_000 }))).toBe(true);
    expect(isOverdue(0, 4_999, policyWith({ overdueAfterMs: 5_000 }))).toBe(false);
  });
});

describe('requestsPerRound', () => {
  it('is one request plus the automatic retries (3 by default)', () => {
    expect(requestsPerRound()).toBe(3);
    expect(requestsPerRound(POLICY)).toBe(1 + POLICY.retriesPerRound);
  });
  it.each([0, 1, 5])('retriesPerRound %i → %i+1 requests', (n) => {
    expect(requestsPerRound(policyWith({ retriesPerRound: n }))).toBe(n + 1);
  });
});

describe('nextAutomaticAction: what the system does next on its own (null = it waits on a person)', () => {
  const offer = (status: AssignmentStatus = 'offered') => ({ status, expiresAt: 77_000, contributorName: 'Ana Ortiz' });

  it.each([
    [0, { kind: 'retry_routing', at: 30_000, nextRequest: 2, requestsPerRound: 3 }],
    [1, { kind: 'retry_routing', at: 30_000, nextRequest: 3, requestsPerRound: 3 }],
    [2, { kind: 'escalate_routing', at: 30_000, requestsPerRound: 3 }],
  ])('routing on request index %i → %j', (retryIndex, expected) => {
    expect(nextAutomaticAction({ status: 'routing', currentAttempt: { retryIndex, deadlineAt: 30_000 }, activeAssignment: null })).toEqual(expected);
  });

  it('the action is due exactly at the request deadline', () => {
    const n = nextAutomaticAction({ status: 'routing', currentAttempt: { retryIndex: 0, deadlineAt: 123_456 }, activeAssignment: null });
    expect(n!.at).toBe(123_456);
  });

  it('with no retries configured, the first request is also the last: it escalates', () => {
    expect(nextAutomaticAction({ status: 'routing', currentAttempt: { retryIndex: 0, deadlineAt: 9 }, activeAssignment: null }, policyWith({ retriesPerRound: 0 }))).toEqual({
      kind: 'escalate_routing',
      at: 9,
      requestsPerRound: 1,
    });
  });

  it('offered with an open offer → the offer expires at its expiry, naming the contributor', () => {
    expect(nextAutomaticAction({ status: 'offered', currentAttempt: null, activeAssignment: offer() })).toEqual({ kind: 'expire_offer', at: 77_000, contributorName: 'Ana Ortiz' });
  });

  it.each(['new', 'assigned', 'in_progress', 'completed', 'needs_attention', 'cancelled'] as TaskStatus[])('%s → null (nothing automatic)', (status) => {
    expect(nextAutomaticAction({ status, currentAttempt: null, activeAssignment: null })).toBeNull();
  });

  it.each(['assigned', 'in_progress'] as TaskStatus[])('%s with an accepted/started assignment → null: accepted work never expires', (status) => {
    expect(nextAutomaticAction({ status, currentAttempt: null, activeAssignment: offer(status === 'assigned' ? 'accepted' : 'in_progress') })).toBeNull();
  });

  it('defensive: routing without a current request, or offered without an open offer, promises nothing', () => {
    expect(nextAutomaticAction({ status: 'routing', currentAttempt: null, activeAssignment: null })).toBeNull();
    expect(nextAutomaticAction({ status: 'offered', currentAttempt: null, activeAssignment: null })).toBeNull();
    expect(nextAutomaticAction({ status: 'offered', currentAttempt: null, activeAssignment: offer('accepted') })).toBeNull();
  });

  it('only the status decides: a stray request on a non-routing task promises no retry', () => {
    for (const status of ['new', 'needs_attention', 'cancelled'] as TaskStatus[]) {
      expect(nextAutomaticAction({ status, currentAttempt: { retryIndex: 0, deadlineAt: 1 }, activeAssignment: null })).toBeNull();
    }
  });
});

describe('POLICY: the numbers hang together', () => {
  const d = POLICY.requestDeadlineMs;

  it('the engine window is ordered and positive', () => {
    expect(POLICY.expectedWindowMs.min).toBeGreaterThan(0);
    expect(POLICY.expectedWindowMs.min).toBeLessThan(POLICY.expectedWindowMs.max);
  });

  it('Overdue starts no earlier than the end of the normal window (it is exactly the window max: 20 s)', () => {
    expect(POLICY.overdueAfterMs).toBeGreaterThanOrEqual(POLICY.expectedWindowMs.max);
    expect(POLICY.overdueAfterMs).toBe(20_000);
  });

  it('every deadline comes after Overdue, so a request is always labelled Overdue before we stop waiting', () => {
    for (const p of PRIORITIES) expect(d[p]).toBeGreaterThan(POLICY.overdueAfterMs);
  });

  it('high priority waits LESS than normal, which waits less than low', () => {
    expect(d.high).toBeLessThan(d.normal);
    expect(d.normal).toBeLessThan(d.low);
    expect(d).toEqual({ high: 30_000, normal: 45_000, low: 60_000 });
  });

  it('every priority has a deadline', () => {
    expect(Object.keys(d).sort()).toEqual([...PRIORITIES].sort());
  });

  it('retries, offer TTL, tick and poll are sane', () => {
    expect(Number.isInteger(POLICY.retriesPerRound)).toBe(true);
    expect(POLICY.retriesPerRound).toBeGreaterThanOrEqual(0);
    expect(POLICY.offerTtlMs).toBeGreaterThan(0);
    expect(POLICY.tickMs).toBeGreaterThan(0);
    expect(POLICY.tickMs).toBeLessThan(Math.min(...Object.values(d), POLICY.offerTtlMs));
    expect(POLICY.pollMs).toBeGreaterThanOrEqual(POLICY.tickMs);
  });

  it('a full round (3 requests at the high deadline) fits the brief: high priority escalates at 90 s', () => {
    expect(requestsPerRound() * d.high).toBe(90_000);
  });
});
