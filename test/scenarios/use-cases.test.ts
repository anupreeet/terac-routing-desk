// The four use cases from the brief, each as an end-to-end scenario with the real simulator,
// a fake clock and a real database. Invariants are checked after every 500 ms of simulated time.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, S, ANA, BEN, CHEN, type Harness } from '../helpers/harness';
import { isOverdue, nextAutomaticAction } from '../../src/shared/policy';

let h: Harness;
afterEach(() => h?.close());

describe('Use case 1 — Routine assignment: a task enters the system, is matched with a suitable contributor, and moves through the normal workflow', () => {
  it('routes, offers to the least-loaded contributor, and runs accept → start → complete with a complete history', () => {
    h = createHarness();
    const id = h.create({ engine: 'quick_match' });
    expect(h.task(id).status).toBe('routing');

    h.advance(5.5 * S);
    expect(h.task(id).status).toBe('routing');
    h.advance(0.5 * S); // the engine answers at 6 s
    expect(h.task(id).status).toBe('offered');
    const offer = h.active(id)!;
    expect(offer.source).toBe('engine');
    expect([ANA, BEN]).toContain(offer.contributorId);
    expect(offer.expiresAt).toBe(h.clock.now() + h.app.policy.offerTtlMs);

    expect(h.respond(id, 'accept')).toEqual({ ok: true });
    expect(h.task(id).status).toBe('assigned');
    expect(h.repo.eventsForTask(id).at(-1)!.summary).toMatch(/Routing complete/);

    h.respond(id, 'start');
    expect(h.task(id).status).toBe('in_progress');
    h.respond(id, 'complete');
    expect(h.task(id).status).toBe('completed');
    expect(h.task(id).closedAt).not.toBeNull();

    expect(h.types(id)).toEqual(['task_created', 'task_submitted', 'attempt_dispatched', 'attempt_matched', 'offer_created', 'offer_accepted', 'work_started', 'work_completed']);
  });
});

describe('Use case 2 — Unresolved routing: a high-priority task remains pending and the operator cannot know whether the engine is slow or will never return', () => {
  it('shows Overdue at 20 s, retries at the 30 s deadline without bumping the version, and hands the task over after 3 requests', () => {
    h = createHarness();
    const id = h.create({ priority: 'high', engine: 'lost_always' });
    const v0 = h.task(id).version;
    const first = h.attempts(id)[0];

    h.advance(19.5 * S);
    expect(isOverdue(first.dispatchedAt, h.clock.now())).toBe(false);
    h.advance(0.5 * S);
    expect(isOverdue(first.dispatchedAt, h.clock.now())).toBe(true); // a label, nothing stored
    expect(h.task(id).status).toBe('routing');

    h.advance(9.5 * S);
    expect(h.attempts(id)).toHaveLength(1);
    h.advance(0.5 * S); // 30 s: high-priority deadline
    const [a1, a2] = h.attempts(id);
    expect(a1.status).toBe('timed_out');
    expect(a1.closedAt).toBe(a1.deadlineAt);
    expect(a2.status).toBe('pending');
    expect(a2.retryIndex).toBe(1);
    expect(h.task(id).version).toBe(v0); // a background retry must not cause a spurious 409

    h.advance(60 * S); // #2 and #3 time out
    const t = h.task(id);
    expect(t.status).toBe('needs_attention');
    expect(t.attentionReason).toBe('routing_exhausted');
    expect(h.attempts(id).map((a) => a.status)).toEqual(['timed_out', 'timed_out', 'timed_out']);
    expect(nextAutomaticAction({ status: t.status, currentAttempt: null, activeAssignment: null })).toBeNull();

    // Idempotent: more time changes nothing.
    const events = h.repo.eventsForTask(id).length;
    h.advance(60 * S);
    expect(h.repo.eventsForTask(id).length).toBe(events);
  });

  it('a request that never answers recovers by itself when the retry gets an answer (lost once)', () => {
    h = createHarness();
    const id = h.create({ priority: 'high', engine: 'lost_once' });
    h.advance(30 * S);
    expect(h.attempts(id)).toHaveLength(2);
    h.advance(6 * S);
    expect(h.task(id).status).toBe('offered');
    expect(h.active(id)!.attemptId).toBe(h.attempts(id)[1].id);
  });
});

describe('Use case 3 — Human intervention: the operator intervenes while routing is pending, and the outstanding request may still return afterward', () => {
  it('a manual offer abandons the pending request; its later answer is recorded and never applied', () => {
    h = createHarness();
    const id = h.create({ engine: 'late_answer' }); // request #1 answers at 40 s (normal deadline 45 s)
    h.advance(22 * S);
    h.cmd(id, { type: 'offer', contributorId: BEN, note: 'Client asked for Ben' });
    expect(h.task(id).status).toBe('offered');
    expect(h.attempts(id)[0].status).toBe('abandoned');
    expect(h.attempts(id)[0].abandonReason).toBe('operator_offer');
    const before = { task: h.task(id), offer: h.active(id) };

    h.advance(20 * S); // the engine answers at 40 s
    const a1 = h.attempts(id)[0];
    expect(a1.resultAt).not.toBeNull();
    expect(a1.resultKind).toBe('match');
    expect(a1.status).toBe('abandoned');
    expect(h.task(id)).toEqual(before.task); // status, version, pointer: unchanged
    expect(h.active(id)).toEqual(before.offer);
    expect(h.repo.assignmentsForTask(id)).toHaveLength(1);
    const ghost = h.repo.eventsForTask(id).at(-1)!;
    expect(ghost.type).toBe('late_result_ignored');
    expect(ghost.summary).toMatch(/Late answer to request #1 after 40\.0s: .*Not applied: the operator had already offered the task to Ben Hale/);
  });

  it('stopping routing returns the task to Not routed; a late answer is still only recorded', () => {
    h = createHarness();
    const id = h.create({ engine: 'late_answer' });
    h.advance(10 * S);
    h.cmd(id, { type: 'stop_routing' });
    expect(h.task(id).status).toBe('new');
    expect(h.task(id).attentionReason).toBeNull();
    h.advance(31 * S);
    expect(h.task(id).status).toBe('new');
    expect(h.types(id).at(-1)).toBe('late_result_ignored');
  });
});

describe('Use case 4 — Recovery: an assignment is declined or fails before work begins, and the operator decides what to do next', () => {
  it('a decline goes to the operator (never auto-rerouted); routing again excludes the decliner', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    expect(h.app.spy!.engine.requests[0].candidates.map((c) => c.contributorId).sort()).toEqual([ANA, BEN]);
    h.cmd(id, { type: 'offer', contributorId: ANA });
    h.respond(id, 'decline', 'Conflict of interest');
    const t = h.task(id);
    expect(t.status).toBe('needs_attention');
    expect(t.attentionReason).toBe('declined');
    h.advance(120 * S);
    expect(h.app.spy!.engine.requests).toHaveLength(1); // nothing automatic happened

    const detail = h.app.views.taskDetail(id)!;
    expect(detail.attention!.title).toBe('Ana Ortiz declined');
    expect(detail.candidates.find((c) => c.contributorId === ANA)!.blocker).toBe('excluded');
    expect(detail.nextAutomaticAction).toBeNull();

    h.cmd(id, { type: 'reroute' });
    const second = h.app.spy!.engine.requests[1];
    expect(second.candidates.map((c) => c.contributorId)).toEqual([BEN]);
    expect(h.task(id).round).toBe(2);
    expect(h.attempts(id).at(-1)!.retryIndex).toBe(0);
    expect(h.attempts(id).at(-1)!.excluded).toEqual([{ contributorId: ANA, name: 'Ana Ortiz', reason: 'declined this task' }]);
  });

  it('an offer nobody answers expires, excludes that contributor, and waits for the operator', () => {
    h = createHarness();
    const id = h.create({ engine: 'quick_match', contributor: 'ignore' });
    h.advance(6 * S);
    const who = h.active(id)!.contributorId;
    h.advance(59.5 * S);
    expect(h.task(id).status).toBe('offered');
    h.advance(0.5 * S);
    expect(h.task(id).status).toBe('needs_attention');
    expect(h.task(id).attentionReason).toBe('offer_expired');
    expect(h.repo.exclusions(id).has(who)).toBe(true);
    expect(h.app.desk.repo.loadOf(who)).toBe(0);
  });

  it('accepted, then withdrew before starting: failed before start, load freed, no automatic re-route, later actions refused', () => {
    h = createHarness();
    const id = h.create({ engine: 'quick_match', contributor: 'withdraw_after_accept' });
    h.advance(6 * S + 4 * S); // offered at 6 s, accepted at 10 s
    expect(h.task(id).status).toBe('assigned');
    const who = h.active(id)!.contributorId;
    h.advance(10 * S); // withdraws 10 s after the offer
    expect(h.task(id).status).toBe('needs_attention');
    expect(h.task(id).attentionReason).toBe('failed_before_start');
    expect(h.app.desk.repo.loadOf(who)).toBe(0);
    expect(h.repo.exclusions(id).get(who)!.status).toBe('withdrawn');
    h.advance(120 * S);
    expect(h.attempts(id)).toHaveLength(1);
    const r = h.respond(id, 'start');
    expect(r.ok).toBe(false);
    expect(h.types(id).at(-1)).toBe('late_response_ignored');
  });

  it('the operator can release an accepted contributor who never showed up (note required by the API)', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ expertiseId: 'healthcare' });
    h.deliver(id, 1, { kind: 'match', contributorId: CHEN });
    h.respond(id, 'accept');
    h.cmd(id, { type: 'release', note: 'No-show for kickoff' });
    expect(h.task(id).status).toBe('needs_attention');
    expect(h.task(id).attentionReason).toBe('failed_before_start');
    expect(h.repo.exclusions(id).get(CHEN)!.status).toBe('released');
  });
});
