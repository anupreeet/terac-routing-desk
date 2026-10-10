// Late, duplicate and stale engine answers. Rule: first terminal transition wins; everything after
// is recorded, never applied.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, S, ANA, BEN, type Harness } from '../helpers/harness';

let h: Harness;
afterEach(() => h?.close());

describe('fencing', () => {
  it('strict fencing: request #1 answering late while #2 is pending is recorded, and #2 still wins', () => {
    h = createHarness();
    const id = h.create({ priority: 'high', engine: 'late_answer' }); // #1 at 40 s; high deadline 30 s; #2 answers 6 s after dispatch
    h.advance(30 * S);
    expect(h.attempts(id).map((a) => a.status)).toEqual(['timed_out', 'pending']);
    h.advance(6 * S); // #2 answers at 36 s
    expect(h.task(id).status).toBe('offered');
    const offer = h.active(id)!;
    expect(offer.attemptId).toBe(h.attempts(id)[1].id);
    h.advance(4 * S); // #1 answers at 40 s
    expect(h.attempts(id)[0].resultAt).not.toBeNull();
    expect(h.active(id)).toEqual(offer);
    expect(h.types(id).at(-1)).toBe('late_result_ignored');
  });

  it('a late answer while a newer request is still pending is not applied, and says which request is pending', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ priority: 'high' });
    h.advance(30 * S); // #1 times out, #2 pending
    const r = h.deliver(id, 1, { kind: 'match', contributorId: ANA });
    expect(r).toEqual({ applied: false, reason: 'late' });
    expect(h.task(id).status).toBe('routing');
    expect(h.task(id).currentAttemptId).toBe(h.attempts(id)[1].id);
    expect(h.repo.eventsForTask(id).at(-1)!.summary).toMatch(/we had stopped waiting at 30s and request #2 is now pending/);
    // The late pick is surfaced as advice the operator can act on.
    const late = h.app.views.taskDetail(id)!.lateAnswers;
    expect(late).toEqual([expect.objectContaining({ attemptSeq: 1, contributorId: ANA, offerableNow: true, whyNot: null })]);
  });

  it('the deadline is judged by when the answer arrived, not when we processed it', () => {
    h = createHarness();
    const id = h.create({ priority: 'high', engine: 'quick_match' });
    const a = h.attempts(id)[0];
    h.app.sim!.scriptEngineJob(a.id, a.dispatchedAt + 29_900); // arrives 100 ms before the 30 s deadline
    h.jump(31 * S); // but nothing runs until 31 s (one late tick)
    expect(h.task(id).status).toBe('offered');
    expect(h.attempts(id)[0].status).toBe('matched');
  });

  it('an answer that arrives exactly at the deadline is late: timeout first, then recorded', () => {
    h = createHarness();
    const id = h.create({ priority: 'high', engine: 'quick_match' });
    const a = h.attempts(id)[0];
    h.app.sim!.scriptEngineJob(a.id, a.deadlineAt);
    h.jump(31 * S);
    const [a1, a2] = h.attempts(id);
    expect(a1.status).toBe('timed_out');
    expect(a1.resultAt).toBe(a.deadlineAt);
    expect(a2.status).toBe('pending');
    expect(h.task(id).status).toBe('routing');
  });

  it('a duplicate delivery changes nothing: one assignment, no new events', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    expect(h.deliver(id, 1, { kind: 'match', contributorId: ANA }).applied).toBe(true);
    const events = h.repo.eventsForTask(id).length;
    const task = h.task(id);
    expect(h.deliver(id, 1, { kind: 'match', contributorId: BEN })).toEqual({ applied: false, reason: 'duplicate' });
    expect(h.repo.eventsForTask(id).length).toBe(events);
    expect(h.task(id)).toEqual(task);
    expect(h.repo.assignmentsForTask(id)).toHaveLength(1);
  });

  it('an answer for an unknown request is ignored and logged as a system event', () => {
    h = createHarness({ world: 'spy' });
    const r = h.app.desk.applyEngineResult(9999, { kind: 'match', contributorId: ANA }, h.clock.now());
    expect(r).toEqual({ applied: false, reason: 'unknown_attempt' });
    expect(h.repo.lastEventOfTypes(['engine_result_unknown_attempt'])).toBeTruthy();
  });

  it('a pick that is no longer eligible is not applied and uses a retry', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    h.app.desk.setAvailability(ANA, 'away');
    const r = h.deliver(id, 1, { kind: 'match', contributorId: ANA });
    expect(r).toEqual({ applied: false, reason: 'invalid_result' });
    expect(h.attempts(id).map((a) => [a.status, a.invalidReason])).toEqual([
      ['invalid_result', 'away'],
      ['pending', null],
    ]);
    expect(h.app.spy!.engine.requests[1].candidates.map((c) => c.contributorId)).toEqual([BEN]);
  });

  it('a pick outside the request’s candidate snapshot is rejected', () => {
    h = createHarness({ world: 'spy' });
    h.app.desk.setAvailability(BEN, 'away');
    const id = h.create();
    const a = h.attempts(id).at(-1)!;
    expect(a.candidates.map((c) => c.contributorId)).toEqual([ANA]);
    h.app.desk.setAvailability(BEN, 'available');
    // A later contributor change does not alter the in-flight request's frozen snapshot…
    expect(h.attempts(id).at(-1)!.candidates.map((c) => c.contributorId)).toEqual([ANA]);
    // …and an answer naming someone outside it is not applied.
    expect(h.deliver(id, 1, { kind: 'match', contributorId: BEN }).reason).toBe('invalid_result');
    expect(h.attempts(id)[0].invalidReason).toBe('not_in_snapshot');
  });

  it('no match goes straight to the operator: no automatic retry', () => {
    h = createHarness();
    const id = h.create({ engine: 'no_match' });
    h.advance(8 * S);
    expect(h.task(id).status).toBe('needs_attention');
    expect(h.task(id).attentionReason).toBe('no_match');
    h.advance(120 * S);
    expect(h.attempts(id)).toHaveLength(1);
  });

  it('cancelling a task while routing: a later answer is recorded and the task stays cancelled', () => {
    h = createHarness();
    const id = h.create({ engine: 'late_answer' });
    h.advance(5 * S);
    h.cmd(id, { type: 'cancel', note: 'Client paused' });
    h.advance(40 * S);
    expect(h.task(id).status).toBe('cancelled');
    expect(h.repo.eventsForTask(id).at(-1)!.summary).toMatch(/Not applied: the task was cancelled/);
  });

  it('a contributor reply after the operator revoked the offer is recorded, not applied', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    h.cmd(id, { type: 'offer', contributorId: ANA });
    h.cmd(id, { type: 'revoke_offer' });
    expect(h.task(id).status).toBe('new');
    expect(h.repo.exclusions(id).has(ANA)).toBe(false); // revoking says nothing about the person
    const r = h.respond(id, 'accept');
    expect(r).toEqual({ ok: false, code: 'assignment_not_active', message: expect.stringMatching(/offer had been revoked/) });
    expect(h.task(id).status).toBe('new');
    expect(h.types(id).at(-1)).toBe('late_response_ignored');
  });

  it('accept versus expiry: one millisecond before wins; at the expiry instant the offer has expired', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    h.cmd(id, { type: 'offer', contributorId: ANA });
    const offer = h.active(id)!;
    h.clock.set(offer.expiresAt - 1);
    expect(h.app.desk.respond(offer.id, 'accept')).toEqual({ ok: true });

    const id2 = h.create();
    h.cmd(id2, { type: 'offer', contributorId: BEN });
    const offer2 = h.active(id2)!;
    h.clock.set(offer2.expiresAt);
    const r = h.app.desk.respond(offer2.id, 'accept');
    expect(r.ok).toBe(false);
    expect(h.task(id2).attentionReason).toBe('offer_expired');
    h.assertInvariants();
  });
});
