// Races between people, the engine and the clock. Everything is serialized through one process's
// synchronous transactions; these tests pin down WHICH side wins each race and what the loser sees.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, S, ANA, BEN, CHEN, type Harness } from '../helpers/harness';
import { SnapshotDto, TaskDetailDto } from '../../src/shared/schemas';

let h: Harness;
afterEach(() => h?.close());

describe('races', () => {
  it('stale expectedVersion → 409 version_conflict listing exactly what changed; the database is untouched', async () => {
    h = createHarness();
    const id = h.create({ engine: 'quick_match' });
    const seen = (await h.http.get(`/api/tasks/${id}`)).body;
    const seenEventId = seen.events.at(-1).id;
    h.advance(6 * S); // engine answers: offered
    const before = h.task(id);

    const res = await h.http.post(`/api/tasks/${id}/commands`).send({ type: 'reroute', expectedVersion: seen.version, seenEventId });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('version_conflict');
    expect(res.body.error.unseen.map((e: { type: string }) => e.type)).toEqual(['attempt_matched', 'offer_created']);
    expect(TaskDetailDto.safeParse(res.body.error.task).success).toBe(true);
    expect(h.task(id)).toEqual(before);
  });

  it('engine answer vs operator offer: an answer already in the inbox is applied first and the operator gets a 409', async () => {
    h = createHarness();
    const id = h.create({ engine: 'quick_match' });
    const v = h.task(id).version;
    h.clock.advance(7 * S); // the answer is due, but no tick has run yet
    const res = await h.http.post(`/api/tasks/${id}/commands`).send({ type: 'offer', contributorId: BEN, expectedVersion: v });
    expect(res.status).toBe(409);
    expect(h.task(id).status).toBe('offered');
    expect(h.repo.assignmentsForTask(id)).toHaveLength(1);
    h.assertInvariants();
  });

  it('two tasks contend for the only free contributor: the second pick is re-checked, refused and retried', () => {
    h = createHarness({ world: 'spy' });
    h.app.desk.setAvailability(BEN, 'away'); // Ana (capacity 1) is the only finance contributor
    const t1 = h.create();
    const t2 = h.create();
    expect(h.attempts(t1)[0].candidates.map((c) => c.contributorId)).toEqual([ANA]);
    expect(h.attempts(t2)[0].candidates.map((c) => c.contributorId)).toEqual([ANA]);

    expect(h.deliver(t1, 1, { kind: 'match', contributorId: ANA }).applied).toBe(true);
    expect(h.deliver(t2, 1, { kind: 'match', contributorId: ANA })).toEqual({ applied: false, reason: 'invalid_result' });
    expect(h.attempts(t2)[0].invalidReason).toBe('at_capacity');
    // The retry finds nobody free, so the engine is not called again and the operator is told why.
    expect(h.task(t2).status).toBe('needs_attention');
    expect(h.task(t2).attentionReason).toBe('no_eligible_contributors');
    expect(h.repo.loadOf(ANA)).toBe(1);
  });

  it('several tasks routed at the same time resolve independently', () => {
    h = createHarness();
    const ids = [h.create({ engine: 'quick_match' }), h.create({ expertiseId: 'healthcare', engine: 'quick_match' }), h.create({ engine: 'lost_always', priority: 'low' })];
    h.advance(6 * S);
    expect(ids.map((id) => h.task(id).status)).toEqual(['offered', 'offered', 'routing']);
    expect(h.active(ids[1])!.contributorId).toBe(CHEN);
  });

  it('offering to someone away, at capacity, outside the expertise, or excluded is refused with the reason', async () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    const v = () => h.task(id).version;
    const post = (body: object) => h.http.post(`/api/tasks/${id}/commands`).send({ type: 'offer', expectedVersion: v(), ...body });

    expect((await post({ contributorId: CHEN })).body.error).toMatchObject({ code: 'contributor_ineligible', reason: 'no_expertise' });
    h.app.desk.setAvailability(BEN, 'away');
    expect((await post({ contributorId: BEN })).body.error).toMatchObject({ code: 'contributor_unavailable', reason: 'away' });

    const other = h.create();
    h.cmd(other, { type: 'offer', contributorId: ANA }); // Ana is now at capacity (1/1)
    expect((await post({ contributorId: ANA })).body.error).toMatchObject({ code: 'contributor_unavailable', reason: 'at_capacity' });

    // Ana declines the other task, freeing her, but she is not excluded from THIS task.
    h.respond(other, 'decline');
    expect((await post({ contributorId: ANA })).status).toBe(200);
    h.respond(id, 'decline'); // now Ana declined this task too
    const res = await post({ contributorId: ANA });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('exclusion_ack_required');
    const ok = await post({ contributorId: ANA, acknowledgeExclusion: true });
    expect(ok.status).toBe(200);
    expect(h.repo.eventsForTask(id).at(-1)!.summary).toMatch(/, although they declined it earlier\./);
  });

  it('commands not valid in the current status are refused with the allowed list', async () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    const res = await h.http.post(`/api/tasks/${id}/commands`).send({ type: 'release', note: 'x', expectedVersion: h.task(id).version });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'invalid_transition', allowed: ['offer', 'reroute', 'stop_routing', 'cancel'] });
  });

  it('the snapshot parses against the shared contract while things are in flight', async () => {
    h = createHarness();
    h.create({ engine: 'quick_match' });
    h.create({ engine: 'lost_always', priority: 'high' });
    h.advance(21 * S);
    const res = await h.http.get('/api/snapshot');
    const parsed = SnapshotDto.safeParse(res.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(res.body.counts).toMatchObject({ routing: 1, overdue: 1, offered: 1 });
  });
});
