// Use case 4 in depth — Recovery: an assignment is declined or fails before work begins (or routing
// itself gives up), and the operator decides what happens next. Rules under test:
//   R7  human outcomes and no_match go to needs_attention and are never auto-rerouted;
//       machine failures retry within the round's budget, then hand over.
//   R8  contributors who declined / expired / withdrew / were released are excluded from engine
//       routing for that task (the operator can still offer, after acknowledging).
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, ANA, BEN, CHEN, S, type Harness } from '../helpers/harness';
import { POLICY } from '../../src/shared/policy';

let h: Harness;
afterEach(() => h?.close());

const spy = () => h.app.spy!.engine.requests;
const detail = (id: number) => h.app.views.taskDetail(id)!;
const offerHttp = (id: number, contributorId: number, extra: object = {}) =>
  h.http.post(`/api/tasks/${id}/commands`).send({ type: 'offer', contributorId, expectedVersion: h.task(id).version, ...extra });

/** Spy world: an engine-routed finance task offered to Ana by request #1. */
function offeredToAna() {
  h = createHarness({ world: 'spy' });
  const id = h.create();
  h.deliver(id, 1, { kind: 'match', contributorId: ANA });
  return id;
}

describe('declined', () => {
  it('lands in needs_attention(declined) with who and why; Ana is excluded; nothing automatic happens afterwards', () => {
    const id = offeredToAna();
    h.respond(id, 'decline', 'Conflict: I advise a competitor');
    const d = detail(id);
    expect(d.status).toBe('needs_attention');
    expect(d.attention).toMatchObject({ reason: 'declined', title: 'Ana Ortiz declined' });
    expect(d.attention!.detail).toContain('Conflict: I advise a competitor');
    expect(d.attention!.detail).toMatch(/excluded from engine routing/);
    expect(d.lastOutcome).toMatchObject({ contributorName: 'Ana Ortiz', status: 'declined', note: 'Conflict: I advise a competitor' });
    expect(d.nextAutomaticAction).toBeNull();
    expect(d.candidates.find((c) => c.contributorId === ANA)).toMatchObject({ blocker: 'excluded', exclusion: { status: 'declined', note: 'Conflict: I advise a competitor' } });
    expect(h.repo.loadOf(ANA)).toBe(0);

    const events = h.types(id).length;
    h.advance(10 * 60 * S);
    expect(spy()).toHaveLength(1);
    expect(h.types(id)).toHaveLength(events);
  });

  it('routing again does not send the decliner to the engine, and the request records why she was left out', () => {
    const id = offeredToAna();
    h.respond(id, 'decline');
    h.cmd(id, { type: 'reroute' });
    expect(spy()[1].candidates.map((c) => c.contributorId)).toEqual([BEN]);
    const a2 = h.attempts(id)[1];
    expect(a2.excluded).toEqual([{ contributorId: ANA, name: 'Ana Ortiz', reason: 'declined this task' }]);
    expect(h.repo.eventsForTask(id).at(-1)!.summary).toMatch(/Not sent: Ana Ortiz \(declined this task\)/);
  });

  it('an engine that names the decliner anyway is not applied: she was not in the request, so the pick is invalid and a retry goes out', () => {
    const id = offeredToAna();
    h.respond(id, 'decline');
    h.cmd(id, { type: 'reroute' });
    expect(h.deliver(id, 2, { kind: 'match', contributorId: ANA })).toEqual({ applied: false, reason: 'invalid_result' });
    expect(h.attempts(id)[1].invalidReason).toBe('not_in_snapshot');
    expect(h.attempts(id)[2].status).toBe('pending');
    expect(h.active(id)).toBeUndefined();
  });

  it('offering the task to the decliner directly needs an explicit acknowledgement; without it nothing changes', async () => {
    const id = offeredToAna();
    h.respond(id, 'decline', 'Too busy');
    const before = JSON.stringify({ t: h.task(id), a: h.repo.assignmentsForTask(id), n: h.repo.eventCount() });
    const res = await offerHttp(id, ANA);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'exclusion_ack_required', exclusion: { contributorId: ANA, status: 'declined', note: 'Too busy' } });
    expect(JSON.stringify({ t: h.task(id), a: h.repo.assignmentsForTask(id), n: h.repo.eventCount() })).toBe(before);

    const ok = await offerHttp(id, ANA, { acknowledgeExclusion: true });
    expect(ok.status).toBe(200);
    expect(ok.body.task.activeAssignment).toMatchObject({ contributorId: ANA, source: 'operator', status: 'offered' });
    const ev = h.repo.eventsForTask(id).at(-1)!;
    expect(ev.payload.overrodeExclusion).toBe(true);
    expect(ev.summary).toMatch(/, although they declined it earlier\./);
  });

  it('acknowledging is harmless when nobody is excluded', async () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    const res = await offerHttp(id, BEN, { acknowledgeExclusion: true });
    expect(res.status).toBe(200);
    expect(h.repo.eventsForTask(id).at(-1)!.payload.overrodeExclusion).toBe(false);
  });

  it('the exclusion is per task: Ana is still a candidate for other finance tasks', () => {
    const id = offeredToAna();
    h.respond(id, 'decline');
    const other = h.create();
    expect(h.attempts(other)[0].candidates.map((c) => c.contributorId).sort()).toEqual([ANA, BEN]);
    expect(h.task(id).status).toBe('needs_attention');
  });

  it('the exclusion lasts for the life of the task: an acknowledged offer that is then revoked does not clear it', () => {
    const id = offeredToAna();
    h.respond(id, 'decline');
    h.cmd(id, { type: 'offer', contributorId: ANA, acknowledgeExclusion: true });
    h.cmd(id, { type: 'revoke_offer' });
    h.cmd(id, { type: 'submit' });
    expect(spy().at(-1)!.candidates.map((c) => c.contributorId)).toEqual([BEN]);
  });

  it('when everyone with the expertise has declined, routing again skips the engine and names who was left out and why', () => {
    const id = offeredToAna();
    h.respond(id, 'decline');
    h.cmd(id, { type: 'reroute' });
    h.deliver(id, 2, { kind: 'match', contributorId: BEN });
    h.respond(id, 'decline');
    const requests = spy().length;
    h.cmd(id, { type: 'reroute' });
    expect(spy()).toHaveLength(requests);
    expect(h.task(id).attentionReason).toBe('no_eligible_contributors');
    const ev = h.repo.eventsForTask(id).at(-1)!;
    expect(ev.type).toBe('routing_no_candidates');
    expect(ev.summary).toMatch(/Ana Ortiz \(declined this task\)/);
    expect(ev.summary).toMatch(/Ben Hale \(declined this task\)/);
    expect(detail(id).attention!.detail).toMatch(/2 excluded for this task/);
  });
});

describe('offer expired', () => {
  function offeredAtT0() {
    h = createHarness({ world: 'spy' });
    const id = h.create({ submit: false });
    h.cmd(id, { type: 'offer', contributorId: ANA });
    return id;
  }

  it('an unanswered offer expires exactly at its deadline: needs_attention(offer_expired), Ana excluded, her capacity freed', () => {
    const id = offeredAtT0();
    const offer = h.active(id)!;
    h.advance(POLICY.offerTtlMs - 500);
    expect(h.task(id).status).toBe('offered');
    expect(h.repo.loadOf(ANA)).toBe(1);
    h.advance(500);
    expect(h.task(id).attentionReason).toBe('offer_expired');
    expect(h.repo.getAssignment(offer.id)).toMatchObject({ status: 'expired', endedAt: offer.expiresAt });
    expect(h.repo.exclusions(id).get(ANA)!.status).toBe('expired');
    expect(h.repo.loadOf(ANA)).toBe(0);
    expect(detail(id).attention).toMatchObject({ title: "Ana Ortiz didn't reply" });
    expect(h.types(id).at(-1)).toBe('offer_expired');
  });

  it('is never re-routed automatically', () => {
    const id = offeredAtT0();
    h.advance(POLICY.offerTtlMs + 10 * 60 * S);
    expect(spy()).toHaveLength(0);
    expect(h.task(id).status).toBe('needs_attention');
  });

  it('routing again leaves out the contributor who let it expire', () => {
    const id = offeredAtT0();
    h.advance(POLICY.offerTtlMs);
    h.cmd(id, { type: 'reroute' });
    expect(spy()[0].candidates.map((c) => c.contributorId)).toEqual([BEN]);
    expect(h.attempts(id)[0].excluded).toEqual([{ contributorId: ANA, name: 'Ana Ortiz', reason: 'let an offer for this task expire' }]);
  });

  it('offering it to her again needs the acknowledgement', async () => {
    const id = offeredAtT0();
    h.advance(POLICY.offerTtlMs);
    const res = await offerHttp(id, ANA);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'exclusion_ack_required', exclusion: { status: 'expired' } });
    expect((await offerHttp(id, ANA, { acknowledgeExclusion: true })).status).toBe(200);
  });

  it('a decline that arrives at the expiry instant is too late: the offer expires and the reply is recorded, not applied', () => {
    const id = offeredAtT0();
    const offer = h.active(id)!;
    h.clock.set(offer.expiresAt); // no tick has run yet: the reply races the reconciler
    const r = h.app.desk.respond(offer.id, 'decline', { note: 'No' });
    expect(r).toMatchObject({ ok: false, code: 'assignment_not_active' });
    expect(h.task(id).attentionReason).toBe('offer_expired');
    expect(h.repo.getAssignment(offer.id)!.status).toBe('expired');
    expect(h.types(id).slice(-2)).toEqual(['offer_expired', 'late_response_ignored']);
    h.assertInvariants();
  });
});

describe('failed before start', () => {
  function accepted() {
    const id = offeredToAna();
    h.respond(id, 'accept');
    return id;
  }

  it('a withdrawal after accepting: failed_before_start, Ana excluded, capacity freed, never re-routed automatically', () => {
    const id = accepted();
    h.respond(id, 'withdraw', 'Travelling for two weeks');
    const d = detail(id);
    expect(d.attention).toMatchObject({ reason: 'failed_before_start', short: 'Ana Ortiz withdrew' });
    expect(d.attention!.detail).toContain('Travelling for two weeks');
    expect(h.repo.exclusions(id).get(ANA)!.status).toBe('withdrawn');
    expect(h.repo.loadOf(ANA)).toBe(0);
    h.advance(10 * 60 * S);
    expect(spy()).toHaveLength(1);
  });

  it('after withdrawing, anything else from Ana is refused and recorded', () => {
    const id = accepted();
    h.respond(id, 'withdraw');
    for (const action of ['start', 'complete', 'accept'] as const) {
      expect(h.respond(id, action)).toMatchObject({ ok: false, code: 'assignment_not_active' });
      expect(h.types(id).at(-1)).toBe('late_response_ignored');
    }
    expect(h.task(id).attentionReason).toBe('failed_before_start');
  });

  it.each([
    [{}, 'missing'],
    [{ note: '' }, 'empty'],
    [{ note: '    ' }, 'blank'],
  ])('the operator must say why when releasing (note %s → 400, nothing changes)', async (body, _label) => {
    const id = accepted();
    const before = JSON.stringify(h.task(id));
    const res = await h.http.post(`/api/tasks/${id}/commands`).send({ type: 'release', expectedVersion: h.task(id).version, ...body });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(JSON.stringify(h.task(id))).toBe(before);
  });

  it('a release with a reason: failed_before_start, the reason kept on the assignment and in history, Ana excluded', async () => {
    const id = accepted();
    const res = await h.http.post(`/api/tasks/${id}/commands`).send({ type: 'release', expectedVersion: h.task(id).version, note: '  No-show for kickoff ' });
    expect(res.status).toBe(200);
    expect(res.body.task.attention).toMatchObject({ reason: 'failed_before_start', short: 'Ana Ortiz released' });
    expect(res.body.task.attention.detail).toMatch(/released by the operator/);
    const asg = h.repo.lastAssignment(id)!;
    expect(asg).toMatchObject({ status: 'released', note: 'No-show for kickoff' });
    const ev = h.repo.eventsForTask(id).at(-1)!;
    expect(ev).toMatchObject({ type: 'assignment_released', actor: 'operator' });
    expect(ev.summary).toContain('No-show for kickoff');
    expect(h.repo.exclusions(id).get(ANA)!.status).toBe('released');
  });

  it('recovery after a release: offer someone else directly, or route again without Ana', () => {
    const id = accepted();
    h.cmd(id, { type: 'release', note: 'No-show' });
    h.cmd(id, { type: 'reroute' });
    expect(spy().at(-1)!.candidates.map((c) => c.contributorId)).toEqual([BEN]);
    expect(h.task(id).round).toBe(2);
    h.cmd(id, { type: 'offer', contributorId: BEN });
    expect(h.task(id).status).toBe('offered');
    expect(h.attempts(id).at(-1)!.abandonReason).toBe('operator_offer');
  });
});

describe('nobody eligible: the engine is not called at all', () => {
  it('no contributor has the expertise: straight to needs_attention, no request row, no engine call, no simulated job', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ expertiseId: 'regulatory' });
    expect(h.task(id)).toMatchObject({ status: 'needs_attention', attentionReason: 'no_eligible_contributors', round: 1, currentAttemptId: null });
    expect(h.attempts(id)).toEqual([]);
    expect(spy()).toEqual([]);
    expect(h.types(id)).toEqual(['task_created', 'task_submitted', 'routing_no_candidates']);
    const a = detail(id).attention!;
    expect(a.title).toBe('No one can take this');
    expect(a.detail).toMatch(/No contributor has Regulatory affairs expertise/);
    expect(detail(id).candidates).toEqual([]);
  });

  it('the same in the simulated world: nothing is queued for the engine', () => {
    h = createHarness();
    h.create({ expertiseId: 'regulatory', engine: 'quick_match' });
    expect(h.app.sim!.pendingJobCount()).toBe(0);
  });

  it('everyone with the expertise is away: the reason counts them, and the engine is not called', () => {
    h = createHarness({ world: 'spy' });
    h.app.desk.setAvailability(ANA, 'away');
    h.app.desk.setAvailability(BEN, 'away');
    const id = h.create();
    expect(spy()).toEqual([]);
    expect(detail(id).attention).toMatchObject({ reason: 'no_eligible_contributors', title: 'No one can take this right now' });
    expect(detail(id).attention!.detail).toMatch(/2 away/);
  });

  it('everyone with the expertise is at capacity: same, with the capacity count', () => {
    h = createHarness({ world: 'spy' });
    for (const who of [ANA, BEN]) {
      const t = h.create({ submit: false });
      h.cmd(t, { type: 'offer', contributorId: who });
    }
    const id = h.create();
    expect(h.attempts(id)).toEqual([]);
    expect(detail(id).attention!.detail).toMatch(/2 at capacity/);
    expect(h.repo.eventsForTask(id).at(-1)!.summary).toMatch(/Ana Ortiz \(at capacity, 1 of 1\)/);
  });

  it('once someone is free again, routing again reaches the engine', () => {
    h = createHarness({ world: 'spy' });
    h.app.desk.setAvailability(ANA, 'away');
    h.app.desk.setAvailability(BEN, 'away');
    const id = h.create();
    h.app.desk.setAvailability(BEN, 'available');
    h.cmd(id, { type: 'reroute' });
    expect(h.task(id).status).toBe('routing');
    expect(spy()[0].candidates.map((c) => c.contributorId)).toEqual([BEN]);
    expect(h.attempts(id)[0].excluded).toEqual([{ contributorId: ANA, name: 'Ana Ortiz', reason: 'away' }]);
  });

  it('an automatic retry that finds nobody free hands over as no_eligible_contributors, not as exhausted', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ priority: 'high' });
    h.app.desk.setAvailability(ANA, 'away');
    h.app.desk.setAvailability(BEN, 'away');
    h.advance(POLICY.requestDeadlineMs.high);
    expect(h.attempts(id).map((a) => a.status)).toEqual(['timed_out']);
    expect(h.task(id).attentionReason).toBe('no_eligible_contributors');
    expect(spy()).toHaveLength(1);
  });

  it('offering to a contributor without the expertise is refused with 422 no_expertise', async () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ submit: false });
    const res = await offerHttp(id, CHEN);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'contributor_ineligible', reason: 'no_expertise' });
    expect(h.task(id).status).toBe('new');
  });

  it('offering to an unknown contributor is a 404 and changes nothing', async () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ submit: false });
    const res = await offerHttp(id, 999);
    expect(res.status).toBe(404);
    expect(h.task(id).status).toBe('new');
  });
});

describe('no match: a definite answer, so it is never retried automatically', () => {
  it('goes straight to needs_attention(no_match) and stays there', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    expect(h.deliver(id, 1, { kind: 'no_match', reason: 'Nobody fits' }).reason).toBe('no_match');
    expect(h.task(id).attentionReason).toBe('no_match');
    expect(h.attempts(id)[0]).toMatchObject({ status: 'no_match', resultKind: 'no_match', resultReason: 'Nobody fits' });
    const d = detail(id);
    expect(d.nextAutomaticAction).toBeNull();
    expect(d.attention!.detail).toMatch(/Request #1 reviewed 2 candidates/);
    h.advance(10 * 60 * S);
    expect(spy()).toHaveLength(1);
    expect(h.attempts(id)).toHaveLength(1);
  });

  it('excludes nobody: routing again sends the same candidates, in a new round with a fresh budget', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    h.deliver(id, 1, { kind: 'no_match' });
    h.cmd(id, { type: 'reroute' });
    expect(spy()[1].candidates.map((c) => c.contributorId).sort()).toEqual([ANA, BEN]);
    expect(h.attempts(id)[1]).toMatchObject({ round: 2, retryIndex: 0, status: 'pending' });
  });

  it('a no-match that arrives after the deadline is only a late answer: the retry carries on and nothing is listed as advice', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ priority: 'high' });
    h.advance(POLICY.requestDeadlineMs.high);
    expect(h.deliver(id, 1, { kind: 'no_match' })).toEqual({ applied: false, reason: 'late' });
    expect(h.task(id).status).toBe('routing');
    expect(detail(id).lateAnswers).toEqual([]);
  });
});

describe('retries exhausted (routing_exhausted)', () => {
  it('three requests with no answer (high: 30 s each) hand the task over at 90 s, with the count in the reason', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ priority: 'high' });
    h.advance(3 * POLICY.requestDeadlineMs.high - 500);
    expect(h.task(id).status).toBe('routing');
    h.advance(500);
    expect(h.task(id).attentionReason).toBe('routing_exhausted');
    const a = detail(id).attention!;
    expect(a.short).toBe('No answer after 3 requests');
    expect(a.detail).toMatch(/3 requests this round, 3 with no answer/);
    expect(h.types(id).at(-1)).toBe('routing_exhausted');
  });

  it('unusable picks count against the same budget as silence', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    for (const seq of [1, 2, 3]) h.deliver(id, seq, { kind: 'match', contributorId: CHEN }); // not in the snapshot
    expect(h.attempts(id).map((a) => [a.status, a.invalidReason])).toEqual([
      ['invalid_result', 'not_in_snapshot'],
      ['invalid_result', 'not_in_snapshot'],
      ['invalid_result', 'not_in_snapshot'],
    ]);
    expect(h.task(id).attentionReason).toBe('routing_exhausted');
  });

  it('a mix — silence, an unusable pick, silence — exhausts the round too', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ priority: 'high' });
    h.advance(POLICY.requestDeadlineMs.high);
    h.app.desk.setAvailability(ANA, 'away');
    h.deliver(id, 2, { kind: 'match', contributorId: ANA }); // Ana went away after #2 was sent
    h.app.desk.setAvailability(ANA, 'available');
    h.advance(POLICY.requestDeadlineMs.high);
    expect(h.attempts(id).map((a) => a.status)).toEqual(['timed_out', 'invalid_result', 'timed_out']);
    expect(h.attempts(id)[1].invalidReason).toBe('away');
    expect(h.task(id).attentionReason).toBe('routing_exhausted');
  });

  it('routing again starts a new round with a fresh budget of three requests', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ priority: 'high' });
    h.advance(3 * POLICY.requestDeadlineMs.high);
    h.cmd(id, { type: 'reroute' });
    h.advance(2 * POLICY.requestDeadlineMs.high);
    expect(h.attempts(id).map((a) => [a.round, a.retryIndex, a.status])).toEqual([
      [1, 0, 'timed_out'],
      [1, 1, 'timed_out'],
      [1, 2, 'timed_out'],
      [2, 0, 'timed_out'],
      [2, 1, 'timed_out'],
      [2, 2, 'pending'],
    ]);
    expect(detail(id).nextAutomaticAction).toMatchObject({ kind: 'escalate_routing' });
    h.advance(POLICY.requestDeadlineMs.high);
    expect(h.task(id).attentionReason).toBe('routing_exhausted');
  });
});

describe('late answers are shown as advice the operator can act on', () => {
  function exhaustedWithLatePick(pick = ANA) {
    h = createHarness({ world: 'spy' });
    const id = h.create({ priority: 'high' });
    h.advance(3 * POLICY.requestDeadlineMs.high);
    expect(h.deliver(id, 1, { kind: 'match', contributorId: pick }).reason).toBe('late');
    return id;
  }

  it('after exhaustion, a late pick is listed as offerable, and offering from it is an ordinary operator offer', () => {
    const id = exhaustedWithLatePick();
    const late = detail(id).lateAnswers;
    expect(late).toEqual([{ attemptId: h.attempts(id)[0].id, attemptSeq: 1, contributorId: ANA, contributorName: 'Ana Ortiz', at: h.clock.now(), offerableNow: true, whyNot: null }]);
    h.cmd(id, { type: 'offer', contributorId: ANA });
    expect(h.active(id)).toMatchObject({ contributorId: ANA, source: 'operator', attemptId: null });
  });

  it.each([
    ['away', (hh: Harness) => hh.app.desk.setAvailability(ANA, 'away'), 'Away'],
    [
      'at capacity',
      (hh: Harness) => {
        const other = hh.create({ submit: false });
        hh.cmd(other, { type: 'offer', contributorId: ANA });
      },
      'At capacity (1/1)',
    ],
  ])('a late pick who is now %s is listed, but not offerable, with the reason', (_label, change, why) => {
    const id = exhaustedWithLatePick();
    change(h);
    expect(detail(id).lateAnswers[0]).toMatchObject({ contributorId: ANA, offerableNow: false, whyNot: why });
  });

  it('a late pick who has since been excluded says so', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    h.cmd(id, { type: 'offer', contributorId: ANA }); // abandons request #1
    h.respond(id, 'decline');
    expect(h.deliver(id, 1, { kind: 'match', contributorId: ANA }).reason).toBe('late');
    expect(detail(id).lateAnswers[0]).toMatchObject({ offerableNow: false, whyNot: 'Excluded: declined this task' });
  });

  it('a late pick outside the expertise is listed as no longer having it', () => {
    const id = exhaustedWithLatePick(CHEN);
    expect(detail(id).lateAnswers[0]).toMatchObject({ contributorId: CHEN, offerableNow: false, whyNot: 'No longer has this expertise' });
  });

  it.each([
    ['offered', 'Someone already has an open offer', (hh: Harness, id: number) => hh.cmd(id, { type: 'offer', contributorId: BEN })],
    [
      'assigned',
      "Can't offer while the task is assigned",
      (hh: Harness, id: number) => {
        hh.cmd(id, { type: 'offer', contributorId: BEN });
        hh.respond(id, 'accept');
      },
    ],
    [
      'in_progress',
      "Can't offer while the task is in progress",
      (hh: Harness, id: number) => {
        hh.cmd(id, { type: 'offer', contributorId: BEN });
        hh.respond(id, 'accept');
        hh.respond(id, 'start');
      },
    ],
    ['cancelled', "Can't offer while the task is cancelled", (hh: Harness, id: number) => hh.cmd(id, { type: 'cancel' })],
  ])('while the task is %s, the advice is shown but not actionable', (_status, why, act) => {
    const id = exhaustedWithLatePick();
    act(h, id);
    expect(detail(id).lateAnswers[0]).toMatchObject({ offerableNow: false, whyNot: why });
  });

  it('a pick for a request the operator abandoned (stop routing) is advice too, offerable from Not routed', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    h.cmd(id, { type: 'stop_routing' });
    h.deliver(id, 1, { kind: 'match', contributorId: BEN });
    expect(detail(id).lateAnswers).toEqual([expect.objectContaining({ attemptSeq: 1, contributorId: BEN, offerableNow: true })]);
  });

  it('requests that never answered, and answers that were applied, are not listed', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ priority: 'high' });
    h.advance(POLICY.requestDeadlineMs.high); // #1 silent
    h.deliver(id, 2, { kind: 'match', contributorId: BEN }); // #2 applied
    expect(h.task(id).status).toBe('offered');
    expect(detail(id).lateAnswers).toEqual([]);
  });
});
