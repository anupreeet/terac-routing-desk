// Edges where two things happen at once, and restarts in the middle of every state.
// One process, synchronous transactions: every race has a winner decided by commit order, and the
// loser is either told (409) or recorded (a ghost event). Restarts enforce every deadline that fell
// due while the desk was down exactly once, before anything else, and measure new clocks from boot.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, ANA, BEN, CHEN, FIXTURE, S, T0, type Harness } from '../helpers/harness';
import { POLICY } from '../../src/shared/policy';

const open: Harness[] = [];
const track = (x: Harness) => (open.push(x), x);
afterEach(() => {
  while (open.length) open.pop()!.close();
});

const onlyAna = (maxActive = 1) => ({
  expertise: FIXTURE.expertise,
  contributors: [
    { id: ANA, name: 'Ana Ortiz', expertise: ['finance'], maxActive },
    { id: CHEN, name: 'Chen Wei', expertise: ['healthcare'], maxActive: 2 },
  ],
});

describe('many tasks contend for one contributor in the same tick (R9: capacity re-checked when a pick is applied)', () => {
  it('five tasks, one free contributor with capacity 1: the first answer in the inbox wins; the other four are refused and handed over', () => {
    const h = track(createHarness({ fixture: onlyAna(1) }));
    const ids = Array.from({ length: 5 }, () => h.create({ engine: 'quick_match' }));
    for (const id of ids) expect(h.attempts(id)[0].candidates.map((c) => c.contributorId)).toEqual([ANA]);
    h.advance(6 * S); // all five answers arrive in the same tick, all naming Ana
    expect(h.task(ids[0]).status).toBe('offered');
    for (const id of ids.slice(1)) {
      expect(h.task(id).attentionReason).toBe('no_eligible_contributors');
      expect(h.attempts(id).map((a) => [a.status, a.invalidReason])).toEqual([['invalid_result', 'at_capacity']]);
    }
    expect(h.repo.loadOf(ANA)).toBe(1);
  });

  it('with capacity 2, exactly two win', () => {
    const h = track(createHarness({ fixture: onlyAna(2) }));
    const ids = Array.from({ length: 5 }, () => h.create({ engine: 'quick_match' }));
    h.advance(6 * S);
    expect(ids.map((id) => h.task(id).status)).toEqual(['offered', 'offered', 'needs_attention', 'needs_attention', 'needs_attention']);
    expect(h.repo.loadOf(ANA)).toBe(2);
  });

  it('when the winner declines, the losers stay with the operator (nothing re-routes them), and can be routed again', () => {
    const h = track(createHarness({ fixture: onlyAna(1) }));
    const ids = Array.from({ length: 3 }, () => h.create({ engine: 'quick_match' }));
    h.advance(6 * S);
    h.respond(ids[0], 'decline');
    h.advance(60 * S);
    expect(ids.map((id) => h.task(id).status)).toEqual(['needs_attention', 'needs_attention', 'needs_attention']);
    expect(h.attempts(ids[1])).toHaveLength(1);
    h.cmd(ids[1], { type: 'reroute' });
    expect(h.attempts(ids[1])[1].candidates.map((c) => c.contributorId)).toEqual([ANA]); // she declined T1, not this task
    h.advance(6 * S);
    expect(h.active(ids[1])!.contributorId).toBe(ANA);
  });

  it('two finance tasks that both pick the same person: the loser retries with a fresh snapshot and gets the other contributor', () => {
    const h = track(createHarness());
    const a = h.create({ engine: 'quick_match' });
    const b = h.create({ engine: 'quick_match' });
    const picks = () => [a, b].map((id) => h.active(id)?.contributorId);
    h.advance(12 * S); // first answers at 6 s; any retry answers 6 s later
    expect(picks().sort()).toEqual([ANA, BEN]);
    for (const id of [a, b]) {
      const atts = h.attempts(id);
      if (atts.length === 2) {
        expect(atts[0].invalidReason).toBe('at_capacity');
        expect(atts[1].candidates).toHaveLength(1);
        expect(atts[1].retryIndex).toBe(1);
      }
    }
  });

  it('capacity couples tasks only through the shared contributor: healthcare contention does not touch finance', () => {
    const h = track(createHarness());
    const health = Array.from({ length: 3 }, () => h.create({ expertiseId: 'healthcare', engine: 'quick_match' }));
    const fin = h.create({ engine: 'quick_match' });
    h.advance(6 * S);
    expect(health.filter((id) => h.task(id).status === 'offered')).toHaveLength(2); // Chen holds 2/2
    expect(h.task(fin).status).toBe('offered');
  });
});

describe('an operator offer and an engine answer at the same instant (PLAN race R1)', () => {
  function answerDueNow() {
    const h = track(createHarness());
    const id = h.create({ engine: 'quick_match' });
    const seen = { version: h.task(id).version, eventId: h.repo.eventsForTask(id).at(-1)!.id };
    h.clock.set(h.attempts(id)[0].dispatchedAt + 6 * S); // the answer is in the inbox; no tick has run
    return { h, id, seen };
  }

  it('via HTTP the inbox is drained first: the engine offer stands, the operator gets a 409 naming what happened', async () => {
    const { h, id, seen } = answerDueNow();
    const res = await h.http.post(`/api/tasks/${id}/commands`).send({ type: 'offer', contributorId: BEN, expectedVersion: seen.version, seenEventId: seen.eventId });
    expect(res.status).toBe(409);
    expect(res.body.error.unseen.map((e: { type: string }) => e.type)).toEqual(['attempt_matched', 'offer_created']);
    expect(h.repo.assignmentsForTask(id)).toHaveLength(1);
    expect(h.active(id)!.source).toBe('engine');
  });

  it('if the operator commits first, the answer that lands in the same millisecond is recorded, never applied', () => {
    const { h, id, seen } = answerDueNow();
    h.app.desk.command(id, { type: 'offer', contributorId: BEN, expectedVersion: seen.version });
    h.app.tick();
    h.assertInvariants();
    expect(h.repo.assignmentsForTask(id)).toHaveLength(1);
    expect(h.active(id)).toMatchObject({ contributorId: BEN, source: 'operator' });
    const ghost = h.repo.eventsForTask(id).at(-1)!;
    expect(ghost.type).toBe('late_result_ignored');
    expect(ghost.summary).toMatch(/operator had already offered the task to Ben Hale/);
  });

  it('even when both name the same person, there is one offer, not two', () => {
    const h = track(createHarness({ world: 'spy' }));
    const id = h.create();
    h.cmd(id, { type: 'offer', contributorId: ANA });
    expect(h.deliver(id, 1, { kind: 'match', contributorId: ANA }).reason).toBe('late');
    expect(h.repo.assignmentsForTask(id)).toHaveLength(1);
    expect(h.repo.loadOf(ANA)).toBe(1);
  });

  it('route again versus an answer in the same instant: the abandoned request’s answer is recorded and the new request carries on', () => {
    const { h, id, seen } = answerDueNow();
    h.app.desk.command(id, { type: 'reroute', expectedVersion: seen.version });
    h.app.tick();
    h.assertInvariants();
    expect(h.task(id).status).toBe('routing');
    expect(h.attempts(id).map((a) => a.status)).toEqual(['abandoned', 'pending']);
    expect(h.repo.eventsForTask(id).at(-1)!.summary).toMatch(/Not applied: the operator had re-routed the task/);
  });

  it('cancel versus an answer in the same instant: cancelled stays cancelled', () => {
    const { h, id, seen } = answerDueNow();
    h.app.desk.command(id, { type: 'cancel', expectedVersion: seen.version });
    h.app.tick();
    expect(h.task(id).status).toBe('cancelled');
    expect(h.repo.assignmentsForTask(id)).toEqual([]);
    expect(h.repo.eventsForTask(id).at(-1)!.summary).toMatch(/Not applied: the task was cancelled/);
  });
});

describe('the operator versus a contributor at the same instant (PLAN race R7: commit order decides)', () => {
  /** Draft offered to Ana at T0 with a scripted contributor; returns when the script's first reply is due. */
  function scripted(contributor: 'accept' | 'decline' | 'withdraw_after_accept') {
    const h = track(createHarness());
    const id = h.create({ submit: false, contributor });
    h.cmd(id, { type: 'offer', contributorId: ANA });
    return { h, id };
  }

  it('accept due at t, the operator cancels at t with what they saw: the accept wins, the operator gets 409 and can then cancel knowingly', async () => {
    const { h, id } = scripted('accept');
    const seen = { v: h.task(id).version, e: h.repo.eventsForTask(id).at(-1)!.id };
    h.clock.set(T0 + 4 * S);
    const res = await h.http.post(`/api/tasks/${id}/commands`).send({ type: 'cancel', expectedVersion: seen.v, seenEventId: seen.e });
    expect(res.status).toBe(409);
    expect(res.body.error.unseen.map((e: { type: string }) => e.type)).toEqual(['offer_accepted']);
    expect(h.task(id).status).toBe('assigned');
    const ok = await h.http.post(`/api/tasks/${id}/commands`).send({ type: 'cancel', expectedVersion: h.task(id).version, note: 'Client paused' });
    expect(ok.status).toBe(200);
    expect(h.repo.lastAssignment(id)!.status).toBe('cancelled');
    expect(h.repo.loadOf(ANA)).toBe(0);
  });

  it('cancel commits first: the accept arriving in the same instant is refused and recorded; the task stays cancelled', () => {
    const { h, id } = scripted('accept');
    h.clock.set(T0 + 4 * S);
    h.app.desk.command(id, { type: 'cancel', expectedVersion: h.task(id).version, note: 'Client paused the project' });
    h.app.tick();
    h.assertInvariants();
    expect(h.task(id).status).toBe('cancelled');
    const ghost = h.repo.eventsForTask(id).at(-1)!;
    expect(ghost.type).toBe('late_response_ignored');
    expect(ghost.summary).toMatch(/task had been cancelled/);
  });

  it('decline due at t, the operator revokes at t: the decline wins (the contributor is excluded), the revoke is a 409', async () => {
    const { h, id } = scripted('decline');
    const v = h.task(id).version;
    h.clock.set(T0 + 4 * S);
    const res = await h.http.post(`/api/tasks/${id}/commands`).send({ type: 'revoke_offer', expectedVersion: v });
    expect(res.status).toBe(409);
    expect(h.task(id).attentionReason).toBe('declined');
    expect(h.repo.exclusions(id).get(ANA)!.status).toBe('declined');
  });

  it('withdrawal due at t, the operator releases at t: the withdrawal wins and is what the history says happened', async () => {
    const { h, id } = scripted('withdraw_after_accept');
    h.advance(4 * S); // accepted
    const v = h.task(id).version;
    h.clock.set(T0 + 10 * S);
    const res = await h.http.post(`/api/tasks/${id}/commands`).send({ type: 'release', note: 'No-show', expectedVersion: v });
    expect(res.status).toBe(409);
    expect(h.repo.lastAssignment(id)!.status).toBe('withdrawn');
    expect(h.types(id)).not.toContain('assignment_released');
  });

  it('accept versus expiry, judged at processing time: one millisecond before the expiry is in time', () => {
    const h = track(createHarness({ world: 'spy' }));
    const id = h.create({ submit: false });
    h.cmd(id, { type: 'offer', contributorId: ANA });
    h.clock.set(h.active(id)!.expiresAt - 1);
    h.app.tick();
    expect(h.respond(id, 'accept')).toEqual({ ok: true });
    h.advance(POLICY.offerTtlMs);
    expect(h.task(id).status).toBe('assigned'); // accepted work never expires
  });
});

describe('restart in the middle of every state: catch-up enforces each deadline exactly once', () => {
  const DOWN = 10 * 60 * S;

  /** Stable states: nothing is due, so a long outage changes nothing about the task. */
  const STABLE: [string, (h: Harness) => number][] = [
    ['new', (h) => h.create({ submit: false })],
    [
      'assigned',
      (h) => {
        const id = h.create({ submit: false });
        h.cmd(id, { type: 'offer', contributorId: ANA });
        h.respond(id, 'accept');
        return id;
      },
    ],
    [
      'in_progress',
      (h) => {
        const id = h.create({ submit: false });
        h.cmd(id, { type: 'offer', contributorId: ANA });
        h.respond(id, 'accept');
        h.respond(id, 'start');
        return id;
      },
    ],
    [
      'completed',
      (h) => {
        const id = h.create({ submit: false });
        h.cmd(id, { type: 'offer', contributorId: ANA });
        for (const a of ['accept', 'start', 'complete'] as const) h.respond(id, a);
        return id;
      },
    ],
    ['needs_attention', (h) => h.create({ expertiseId: 'regulatory' })],
    [
      'cancelled',
      (h) => {
        const id = h.create({ engine: 'lost_always' });
        h.cmd(id, { type: 'cancel' });
        return id;
      },
    ],
  ];

  it.each(STABLE)('%s: a ten-minute outage changes nothing about the task; the restart says nothing came due', (_s, reach) => {
    const h1 = track(createHarness({ file: true }));
    const id = reach(h1);
    h1.advance(S);
    const task = h1.task(id);
    const events = h1.types(id);
    const h2 = track(h1.restart(h1.clock.now() + DOWN));
    expect(h2.task(id)).toEqual(task);
    expect(h2.types(id)).toEqual(events);
    expect(h2.repo.lastEventOfTypes(['desk_restarted'])!.summary).toMatch(/Nothing came due while it was down/);
  });

  it('routing, never answers, down long past every deadline: ONE timeout at its real deadline, the retry goes out at boot with a fresh deadline', () => {
    const h1 = track(createHarness({ file: true }));
    const id = h1.create({ engine: 'lost_always' }); // normal: 45 s deadline
    h1.advance(10 * S);
    const boot = T0 + DOWN;
    const h2 = track(h1.restart(boot));
    const [a1, a2] = h2.attempts(id);
    expect(h2.attempts(id)).toHaveLength(2);
    expect(a1).toMatchObject({ status: 'timed_out', closedAt: T0 + POLICY.requestDeadlineMs.normal });
    expect(a2).toMatchObject({ status: 'pending', dispatchedAt: boot, deadlineAt: boot + POLICY.requestDeadlineMs.normal, retryIndex: 1 });
    expect(h2.types(id).filter((t) => t === 'attempt_timed_out')).toHaveLength(1);
    const timeout = h2.repo.eventsForTask(id).find((e) => e.type === 'attempt_timed_out')!;
    expect(timeout.at).toBe(boot); // enforced at startup…
    expect(timeout.payload).toMatchObject({ deadlineAt: a1.deadlineAt, catchUp: true }); // …for the deadline it actually had

    const events = h2.types(id);
    const h3 = track(h2.restart(boot + S));
    expect(h3.types(id)).toEqual(events);
    expect(h3.attempts(id)).toHaveLength(2);
  });

  it('routing, the answer reached the inbox while down but after the deadline: timed out at the deadline, answer recorded late, retry from boot', () => {
    const h1 = track(createHarness({ file: true }));
    const id = h1.create({ engine: 'late_answer', priority: 'high' }); // #1 answers at 40 s; deadline 30 s
    h1.advance(10 * S);
    const boot = T0 + 100 * S;
    const h2 = track(h1.restart(boot));
    const [a1, a2] = h2.attempts(id);
    expect(a1).toMatchObject({ status: 'timed_out', closedAt: T0 + 30 * S, resultAt: T0 + 40 * S, resultKind: 'match' });
    expect(a2).toMatchObject({ status: 'pending', dispatchedAt: boot });
    expect(h2.types(id).filter((t) => t === 'attempt_timed_out')).toHaveLength(1);
    expect(h2.types(id)).toContain('late_result_ignored');
    h2.advance(6 * S); // late_answer: later requests answer after 6 s
    expect(h2.task(id).status).toBe('offered');
  });

  it('the restart summary counts a timeout that catch-up applied while processing a late answer', () => {
    const h1 = track(createHarness({ file: true }));
    h1.create({ engine: 'late_answer', priority: 'high' });
    h1.advance(10 * S);
    const h2 = track(h1.restart(T0 + 100 * S));
    expect(h2.attempts(h2.repo.listTasks()[0].id).map((x) => x.status)).toEqual(['timed_out', 'pending']); // a timeout DID happen during catch-up
    const summary = h2.repo.lastEventOfTypes(['desk_restarted'])!.summary;
    expect(summary, summary).toMatch(/1 request timed out/);
  });

  it('offered, the offer expired while down: expired once, at its real expiry; a second restart changes nothing', () => {
    const h1 = track(createHarness({ file: true }));
    const id = h1.create({ submit: false, contributor: 'ignore' });
    h1.cmd(id, { type: 'offer', contributorId: ANA });
    const offer = h1.active(id)!;
    h1.advance(S);
    const h2 = track(h1.restart(T0 + DOWN));
    expect(h2.task(id).attentionReason).toBe('offer_expired');
    expect(h2.repo.getAssignment(offer.id)).toMatchObject({ status: 'expired', endedAt: offer.expiresAt });
    expect(h2.types(id).filter((t) => t === 'offer_expired')).toHaveLength(1);
    expect(h2.repo.lastEventOfTypes(['desk_restarted'])!.summary).toMatch(/1 offer expired/);
    const events = h2.types(id);
    const h3 = track(h2.restart(T0 + DOWN + S));
    expect(h3.types(id)).toEqual(events);
  });

  it('offered, the contributor’s accept fell due while down but before the expiry: applied at boot, judged at processing time', () => {
    const h1 = track(createHarness({ file: true }));
    const id = h1.create({ submit: false, contributor: 'accept' }); // accepts 4 s after the offer
    h1.cmd(id, { type: 'offer', contributorId: ANA });
    h1.advance(S);
    const boot = T0 + 30 * S; // the offer is still open (expires at 60 s)
    const h2 = track(h1.restart(boot));
    expect(h2.task(id).status).toBe('assigned');
    expect(h2.repo.lastAssignment(id)!.respondedAt).toBe(boot);
    const accepted = h2.repo.eventsForTask(id).find((e) => e.type === 'offer_accepted')!;
    expect(accepted.at).toBe(boot);
    expect(accepted.payload.catchUp).toBe(true);
    expect(h2.repo.lastEventOfTypes(['desk_restarted'])!.summary).toMatch(/1 contributor reply received/);
  });

  it('offered, the accept AND the expiry both fell due while down: the reply is processed at boot, after the expiry, so it is refused and recorded', () => {
    const h1 = track(createHarness({ file: true }));
    const id = h1.create({ submit: false, contributor: 'accept' });
    h1.cmd(id, { type: 'offer', contributorId: ANA });
    const offer = h1.active(id)!;
    h1.advance(S);
    const h2 = track(h1.restart(T0 + DOWN));
    expect(h2.task(id).attentionReason).toBe('offer_expired');
    expect(h2.repo.getAssignment(offer.id)).toMatchObject({ status: 'expired', endedAt: offer.expiresAt });
    expect(h2.types(id).filter((t) => t === 'offer_expired')).toHaveLength(1);
    expect(h2.types(id).at(-1)).toBe('late_response_ignored');
  });

  it('the restart summary counts an offer that expired while catch-up processed a reply to it', () => {
    const h1 = track(createHarness({ file: true }));
    const id = h1.create({ submit: false, contributor: 'accept' });
    h1.cmd(id, { type: 'offer', contributorId: ANA });
    h1.advance(S);
    const h2 = track(h1.restart(T0 + DOWN));
    expect(h2.task(id).attentionReason).toBe('offer_expired'); // an offer DID expire during catch-up
    const summary = h2.repo.lastEventOfTypes(['desk_restarted'])!.summary;
    expect(summary, summary).toMatch(/1 offer expired/);
  });

  it('assigned, a scripted withdrawal fell due while down: applied at boot (failed before start)', () => {
    const h1 = track(createHarness({ file: true }));
    const id = h1.create({ submit: false, contributor: 'withdraw_after_accept' });
    h1.cmd(id, { type: 'offer', contributorId: ANA });
    h1.advance(5 * S);
    expect(h1.task(id).status).toBe('assigned');
    const h2 = track(h1.restart(T0 + DOWN));
    expect(h2.task(id).attentionReason).toBe('failed_before_start');
    expect(h2.repo.lastAssignment(id)!.status).toBe('withdrawn');
  });

  it('only catch-up work is tagged catchUp: what happens after boot is not', () => {
    const h1 = track(createHarness({ file: true }));
    const id = h1.create({ engine: 'lost_always', priority: 'high' });
    h1.advance(S);
    const h2 = track(h1.restart(T0 + 40 * S)); // #1 timed out at 30 s while down; #2 sent at boot (deadline 70 s)
    h2.advance(30 * S); // #2 times out live
    const timeouts = h2.repo.eventsForTask(id).filter((e) => e.type === 'attempt_timed_out');
    expect(timeouts.map((e) => e.payload.catchUp ?? false)).toEqual([true, false]);
  });

  it('a request still in flight is answered after the restart by the same simulated engine, through the same fencing', () => {
    const h1 = track(createHarness({ file: true }));
    const stillOpen = h1.create({ engine: 'late_answer' }); // answers at 40 s, deadline 45 s
    const abandoned = h1.create({ engine: 'late_answer' });
    h1.advance(S);
    h1.cmd(abandoned, { type: 'stop_routing' });
    const h2 = track(h1.restart(T0 + 20 * S));
    h2.advance(20 * S);
    expect(h2.task(stillOpen).status).toBe('offered');
    expect(h2.task(abandoned).status).toBe('new');
    expect(h2.types(abandoned).at(-1)).toBe('late_result_ignored');
  });
});
