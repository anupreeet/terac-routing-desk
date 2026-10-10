// The demo presets' hints are shown to users in the create form, so each one must be literally true.
// Every preset is driven through the real simulator (sim_jobs inbox + pump) with the FakeClock, and
// observed only through the desk: attempts, assignments, task status and history.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, ANA, BEN, S, T0, type Harness } from '../helpers/harness';
import { CONTRIBUTOR_PRESETS, ENGINE_PRESETS, type ContributorPreset, type EnginePreset } from '../../src/shared/sim-presets';
import { POLICY } from '../../src/shared/policy';

let h: Harness;
afterEach(() => h?.close());

const hint = (id: EnginePreset | ContributorPreset) => [...ENGINE_PRESETS, ...CONTRIBUTOR_PRESETS].find((p) => p.id === id)!.hint;
const latencyOf = (a: { resultAt: number | null; dispatchedAt: number }) => (a.resultAt === null ? null : a.resultAt - a.dispatchedAt);
const TEN_MINUTES = 10 * 60 * S;

describe('every preset in the create form is covered here', () => {
  it('engine presets', () => {
    expect(ENGINE_PRESETS.map((p) => p.id).sort()).toEqual(['late_answer', 'lost_always', 'lost_once', 'no_match', 'quick_match', 'realistic']);
  });
  it('contributor presets', () => {
    expect(CONTRIBUTOR_PRESETS.map((p) => p.id).sort()).toEqual(['accept', 'decline', 'ignore', 'manual', 'withdraw_after_accept']);
  });
  it('every preset has a label and a hint', () => {
    for (const p of [...ENGINE_PRESETS, ...CONTRIBUTOR_PRESETS]) {
      expect(p.label.trim(), p.id).not.toBe('');
      expect(p.hint.trim(), p.id).not.toBe('');
    }
  });
});

describe(`engine preset quick_match — "${hint('quick_match')}"`, () => {
  it('the hint says 6s', () => expect(hint('quick_match')).toContain('6s'));

  it('request #1 answers with a match exactly 6 s after dispatch', () => {
    h = createHarness();
    const id = h.create({ engine: 'quick_match' });
    h.advance(5.5 * S);
    expect(h.task(id).status).toBe('routing');
    h.advance(0.5 * S);
    expect(h.task(id).status).toBe('offered');
    const [a1] = h.attempts(id);
    expect(a1.status).toBe('matched');
    expect(latencyOf(a1)).toBe(6 * S);
    expect(h.active(id)!.source).toBe('engine');
  });

  it('every later request also answers with a match after 6 s (stop, route again: both requests answer)', () => {
    h = createHarness();
    const id = h.create({ engine: 'quick_match' });
    h.advance(2 * S);
    h.cmd(id, { type: 'stop_routing' });
    h.cmd(id, { type: 'submit' }); // request #2 at 2 s
    h.advance(6 * S);
    const [a1, a2] = h.attempts(id);
    expect(latencyOf(a1)).toBe(6 * S); // #1 still answered at 6 s, recorded but not applied (it was abandoned)
    expect(a1.resultKind).toBe('match');
    expect(a1.status).toBe('abandoned');
    expect(latencyOf(a2)).toBe(6 * S);
    expect(a2.status).toBe('matched');
    expect(h.task(id).status).toBe('offered');
  });

  it.each(['high', 'normal', 'low'] as const)('answers at 6 s whatever the priority (%s)', (priority) => {
    h = createHarness();
    const id = h.create({ engine: 'quick_match', priority });
    h.advance(6 * S);
    expect(latencyOf(h.attempts(id)[0])).toBe(6 * S);
    expect(h.task(id).status).toBe('offered');
  });
});

describe(`engine preset late_answer — "${hint('late_answer')}"`, () => {
  it('the hint says 40s for request #1 and 6s for later ones', () => {
    expect(hint('late_answer')).toContain('40s');
    expect(hint('late_answer')).toContain('6s');
  });

  it.each(['normal', 'low'] as const)('%s priority: request #1 answers at 40 s, before the deadline, and is applied', (priority) => {
    h = createHarness();
    const id = h.create({ engine: 'late_answer', priority });
    h.advance(39.5 * S);
    expect(h.task(id).status).toBe('routing');
    h.advance(0.5 * S);
    expect(h.task(id).status).toBe('offered');
    expect(h.attempts(id)).toHaveLength(1);
    expect(latencyOf(h.attempts(id)[0])).toBe(40 * S);
  });

  it('high priority: request #1 times out at 30 s, request #2 matches 6 s later, and #1 still answers at 40 s (recorded, not applied)', () => {
    h = createHarness();
    const id = h.create({ engine: 'late_answer', priority: 'high' });
    h.advance(36 * S);
    expect(h.task(id).status).toBe('offered');
    h.advance(4 * S);
    const [a1, a2] = h.attempts(id);
    expect(a1.status).toBe('timed_out');
    expect(latencyOf(a1)).toBe(40 * S);
    expect(a2.status).toBe('matched');
    expect(latencyOf(a2)).toBe(6 * S);
    expect(h.types(id).at(-1)).toBe('late_result_ignored');
  });

  it('a request routed again by the operator also answers after 6 s', () => {
    h = createHarness();
    const id = h.create({ engine: 'late_answer' });
    h.advance(10 * S);
    h.cmd(id, { type: 'reroute' });
    h.advance(6 * S);
    expect(h.task(id).status).toBe('offered');
    expect(latencyOf(h.attempts(id)[1])).toBe(6 * S);
  });
});

describe(`engine preset lost_once — "${hint('lost_once')}"`, () => {
  it('request #1 never answers, not even long after its deadline; request #2 matches after 6 s', () => {
    h = createHarness();
    const id = h.create({ engine: 'lost_once', priority: 'low' });
    h.advance(POLICY.requestDeadlineMs.low);
    expect(h.attempts(id).map((a) => a.status)).toEqual(['timed_out', 'pending']);
    h.advance(6 * S);
    expect(h.task(id).status).toBe('offered');
    expect(latencyOf(h.attempts(id)[1])).toBe(6 * S);
    h.advance(TEN_MINUTES);
    expect(h.attempts(id)[0].resultAt).toBeNull();
  });
});

describe(`engine preset lost_always — "${hint('lost_always')}"`, () => {
  it('no request ever answers: the round is exhausted, and a second round answers no better', () => {
    h = createHarness();
    const id = h.create({ engine: 'lost_always', priority: 'high' });
    h.advance(3 * POLICY.requestDeadlineMs.high);
    expect(h.task(id).attentionReason).toBe('routing_exhausted');
    h.cmd(id, { type: 'reroute' });
    h.advance(3 * POLICY.requestDeadlineMs.high);
    expect(h.task(id).attentionReason).toBe('routing_exhausted');
    h.advance(TEN_MINUTES);
    const attempts = h.attempts(id);
    expect(attempts).toHaveLength(6);
    expect(attempts.every((a) => a.resultAt === null && a.status === 'timed_out')).toBe(true);
    expect(h.types(id)).not.toContain('late_result_ignored');
  });
});

describe(`engine preset no_match — "${hint('no_match')}"`, () => {
  it('the hint says 8s for request #1 and 6s for later ones', () => {
    expect(hint('no_match')).toContain('8s');
    expect(hint('no_match')).toContain('6s');
  });

  it('request #1 reports no match at 8 s (not retried); routing again matches after 6 s', () => {
    h = createHarness();
    const id = h.create({ engine: 'no_match' });
    h.advance(7.5 * S);
    expect(h.task(id).status).toBe('routing');
    h.advance(0.5 * S);
    expect(h.task(id).status).toBe('needs_attention');
    expect(h.task(id).attentionReason).toBe('no_match');
    expect(h.attempts(id)[0]).toMatchObject({ status: 'no_match', resultKind: 'no_match' });
    expect(latencyOf(h.attempts(id)[0])).toBe(8 * S);
    h.advance(60 * S);
    expect(h.attempts(id)).toHaveLength(1);
    h.cmd(id, { type: 'reroute' });
    h.advance(6 * S);
    expect(h.task(id).status).toBe('offered');
    expect(h.attempts(id)[1]).toMatchObject({ status: 'matched', resultKind: 'match' });
  });
});

describe(`engine preset realistic — "${hint('realistic')}"`, () => {
  const N = 200;
  function run(seed: string) {
    h = createHarness({ seed, fixture: { expertise: [{ id: 'finance', label: 'Finance' }], contributors: [1, 2, 3, 4, 5].map((id) => ({ id, name: `C${id}`, expertise: ['finance'], maxActive: 5 })) } });
    const ids = Array.from({ length: N }, () => h.create({ engine: 'realistic', priority: 'low' }));
    h.jump(91 * S); // past the slowest possible answer (90 s)
    const first = ids.map((id) => h.attempts(id)[0]);
    return { first, latencies: first.map(latencyOf) };
  }

  it('the hint says 5–20s and 1 in 5', () => {
    expect(hint('realistic')).toContain('5–20s');
    expect(hint('realistic')).toMatch(/1 in 5/);
  });

  it('about 1 in 5 requests never answer', () => {
    const { latencies } = run('preset-realistic');
    const never = latencies.filter((l) => l === null).length / N;
    expect(never).toBeGreaterThan(0.13);
    expect(never).toBeLessThan(0.27);
  });

  it('answers usually land in 5–20 s, sometimes later, never before 5 s or after 90 s', () => {
    const { latencies } = run('preset-realistic');
    const answered = latencies.filter((l): l is number => l !== null);
    const inWindow = answered.filter((l) => l >= 5 * S && l <= 20 * S).length / answered.length;
    expect(inWindow).toBeGreaterThan(0.8);
    expect(answered.some((l) => l > 20 * S)).toBe(true);
    expect(Math.min(...answered)).toBeGreaterThanOrEqual(5 * S);
    expect(Math.max(...answered)).toBeLessThanOrEqual(90 * S);
  });

  it('is seeded: the same seed replays identically, another seed differs', () => {
    const a = run('preset-realistic').latencies;
    h.close();
    const b = run('preset-realistic').latencies;
    h.close();
    const c = run('another-seed').latencies;
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  });

  it('a slow answer that lands after the deadline is recorded, never applied', () => {
    const { first } = run('preset-realistic');
    const late = first.filter((a) => a.resultAt !== null && a.resultAt >= a.deadlineAt);
    expect(late.length).toBeGreaterThan(0);
    for (const a of late) expect(a.status).toBe('timed_out');
  });
});

// ── Contributor presets ─────────────────────────────────────────────────────

/** A draft with a contributor preset, offered by the operator to Ana at T0 (the first offer). */
function offeredAtT0(contributor: ContributorPreset) {
  h = createHarness();
  const id = h.create({ submit: false, contributor });
  h.cmd(id, { type: 'offer', contributorId: ANA });
  return id;
}
const lastPayload = (id: number) => h.repo.eventsForTask(id).at(-1)!.payload;

describe(`contributor preset manual — "${hint('manual')}"`, () => {
  it('nobody replies on their own, so the offer expires after the offer window', () => {
    const id = offeredAtT0('manual');
    h.advance(POLICY.offerTtlMs - 500);
    expect(h.task(id).status).toBe('offered');
    h.advance(500);
    expect(h.task(id).attentionReason).toBe('offer_expired');
  });

  it('a "Respond as" click answers for the contributor', async () => {
    const id = offeredAtT0('manual');
    h.advance(10 * S);
    const res = await h.http.post(`/api/sim/assignments/${h.active(id)!.id}/respond`).send({ action: 'accept' });
    expect(res.status).toBe(200);
    expect(h.task(id).status).toBe('assigned');
    expect(lastPayload(id).simulatedBy).toBe('button');
  });
});

describe(`contributor preset accept — "${hint('accept')}"`, () => {
  it('the hint says 4s', () => expect(hint('accept')).toContain('4s'));

  it('accepts exactly 4 s after the offer, and then does nothing more by itself', () => {
    const id = offeredAtT0('accept');
    h.advance(3.5 * S);
    expect(h.task(id).status).toBe('offered');
    h.advance(0.5 * S);
    expect(h.task(id).status).toBe('assigned');
    expect(h.active(id)!.respondedAt).toBe(T0 + 4 * S);
    expect(lastPayload(id).simulatedBy).toBe('preset');
    h.advance(TEN_MINUTES);
    expect(h.task(id).status).toBe('assigned');
  });

  it('works the same on an engine pick: offered at 6 s, accepted at 10 s', () => {
    h = createHarness();
    const id = h.create({ engine: 'quick_match', contributor: 'accept' });
    h.advance(9.5 * S);
    expect(h.task(id).status).toBe('offered');
    h.advance(0.5 * S);
    expect(h.task(id).status).toBe('assigned');
  });
});

describe(`contributor preset decline — "${hint('decline')}"`, () => {
  it('the hint says 4s and promises a reason', () => {
    expect(hint('decline')).toContain('4s');
    expect(hint('decline')).toMatch(/reason/);
  });

  it('declines exactly 4 s after the offer, with a reason that reaches the operator', () => {
    const id = offeredAtT0('decline');
    h.advance(3.5 * S);
    expect(h.task(id).status).toBe('offered');
    h.advance(0.5 * S);
    expect(h.task(id).attentionReason).toBe('declined');
    const asg = h.repo.lastAssignment(id)!;
    expect(asg.status).toBe('declined');
    expect(asg.note).toBeTruthy();
    expect(h.app.views.taskDetail(id)!.attention!.detail).toContain(asg.note!);
    expect(lastPayload(id)).toMatchObject({ simulatedBy: 'preset', note: asg.note });
  });
});

describe(`contributor preset ignore — "${hint('ignore')}"`, () => {
  it('never replies: the offer expires at the end of the window and the contributor is excluded', () => {
    const id = offeredAtT0('ignore');
    h.advance(POLICY.offerTtlMs - 500);
    expect(h.task(id).status).toBe('offered');
    h.advance(500);
    expect(h.task(id).attentionReason).toBe('offer_expired');
    expect(h.repo.exclusions(id).get(ANA)!.status).toBe('expired');
    expect(h.types(id)).not.toContain('late_response_ignored');
  });
});

describe(`contributor preset withdraw_after_accept — "${hint('withdraw_after_accept')}"`, () => {
  it('the hint says 4s and 10s', () => {
    expect(hint('withdraw_after_accept')).toContain('4s');
    expect(hint('withdraw_after_accept')).toContain('10s');
  });

  it('accepts at 4 s, then withdraws before starting at 10 s, with a reason', () => {
    const id = offeredAtT0('withdraw_after_accept');
    h.advance(4 * S);
    expect(h.task(id).status).toBe('assigned');
    h.advance(5.5 * S);
    expect(h.task(id).status).toBe('assigned');
    h.advance(0.5 * S);
    expect(h.task(id).attentionReason).toBe('failed_before_start');
    const asg = h.repo.lastAssignment(id)!;
    expect(asg.status).toBe('withdrawn');
    expect(asg.startedAt).toBeNull();
    expect(asg.note).toBeTruthy();
  });

  it('"before starting" is real: if work starts first (Respond as → start), the withdrawal never happens', async () => {
    const id = offeredAtT0('withdraw_after_accept');
    h.advance(5 * S);
    const res = await h.http.post(`/api/sim/assignments/${h.active(id)!.id}/respond`).send({ action: 'start' });
    expect(res.status).toBe(200);
    h.advance(10 * S);
    expect(h.task(id).status).toBe('in_progress');
    expect(h.types(id)).not.toContain('assignment_withdrawn');
  });
});

describe('contributor presets script the FIRST offer only; later offers wait for "Respond as"', () => {
  it.each(['accept', 'decline', 'withdraw_after_accept'] as ContributorPreset[])('%s: a second offer gets no scripted reply and expires', (preset) => {
    const id = offeredAtT0(preset);
    h.advance(10 * S); // the first offer has played out its script
    const t = h.task(id);
    if (t.status === 'assigned') h.cmd(id, { type: 'release', note: 'Rebooking' });
    expect(h.task(id).status).toBe('needs_attention');
    h.cmd(id, { type: 'offer', contributorId: BEN });
    const second = h.active(id)!;
    const events = h.types(id).length;
    h.advance(POLICY.offerTtlMs - 500);
    expect(h.task(id).status).toBe('offered');
    expect(h.types(id).length).toBe(events);
    h.advance(500);
    expect(h.repo.getAssignment(second.id)!.status).toBe('expired');
  });

  it('the script is tied to the first offer: if it is revoked early, the scripted accept is ignored and the next offer is untouched', () => {
    const id = offeredAtT0('accept');
    h.advance(1 * S);
    h.cmd(id, { type: 'revoke_offer' });
    h.cmd(id, { type: 'offer', contributorId: BEN });
    h.advance(3 * S); // the scripted accept for Ana's revoked offer arrives at 4 s
    expect(h.task(id).status).toBe('offered');
    expect(h.active(id)!.contributorId).toBe(BEN);
    const ghost = h.repo.eventsForTask(id).at(-1)!;
    expect(ghost.type).toBe('late_response_ignored');
    expect(ghost.payload).toMatchObject({ simulatedBy: 'preset', action: 'accept' });
  });

  it('a "Respond as" click takes over: the scripted reply for that offer is cancelled', async () => {
    const id = offeredAtT0('accept');
    h.advance(2 * S);
    const res = await h.http.post(`/api/sim/assignments/${h.active(id)!.id}/respond`).send({ action: 'decline', note: 'Changed my mind' });
    expect(res.status).toBe(200);
    h.advance(10 * S);
    expect(h.task(id).attentionReason).toBe('declined');
    expect(h.types(id)).not.toContain('late_response_ignored');
    expect(h.app.sim!.pendingJobCount()).toBe(0);
  });
});
