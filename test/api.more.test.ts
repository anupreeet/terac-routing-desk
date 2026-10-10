// The HTTP surface, endpoint by endpoint: success shapes parse with the shared zod DTOs; malformed
// input is a 400, unknown things are 404s, refusals are 409/422 with the details the UI needs, and a
// genuine server fault is a 500 with an errorId and nothing half-written. Plus R12: no response,
// anywhere, reveals what the simulated engine has planned for a request.
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHarness, ANA, BEN, CHEN, S, T0, type Harness } from './helpers/harness';
import { TASK_STATES, named } from './helpers/states';
import { ApiErrorDto, DeliverResultDto, SnapshotDto, TaskDetailDto } from '../src/shared/schemas';
import { POLICY, isFinal } from '../src/shared/policy';
import { ENGINE_PRESETS, CONTRIBUTOR_PRESETS } from '../src/shared/sim-presets';
import { openDb } from '../src/server/infra/db';
import { FakeClock } from '../src/server/infra/clock';
import { createApp } from '../src/server/app';
import { checkInvariants } from '../src/server/infra/invariants';

let h: Harness;
afterEach(() => h?.close());

const parsedOk = (schema: { safeParse(x: unknown): { success: boolean; error?: { issues: unknown } } }, x: unknown) => {
  const r = schema.safeParse(x);
  expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
};
const expectError = (res: { status: number; body: unknown }, status: number, code: string) => {
  expect(res.status).toBe(status);
  parsedOk(ApiErrorDto, res.body);
  expect((res.body as { error: { code: string } }).error.code).toBe(code);
};

describe('GET /api/health', () => {
  it('reports ok, the server clock, the boot id and the last tick, and never the simulation seed (R12)', async () => {
    h = createHarness();
    const res = await h.http.get('/api/health');
    expect(res.status).toBe(200);
    // With the seed and the (public) RNG, anyone could compute every request's fate in advance.
    expect(res.body).toEqual({ ok: true, serverNow: T0, bootId: expect.any(String), lastTickAt: T0 });
    expect(JSON.stringify(res.body)).not.toContain('test');
    const snap = (await h.http.get('/api/snapshot')).body;
    expect(res.body.bootId).toBe(snap.bootId);
  });

  it('lastTickAt follows the reconciler', async () => {
    h = createHarness();
    h.advance(5 * S);
    expect((await h.http.get('/api/health')).body.lastTickAt).toBe(T0 + 5 * S);
  });
});

describe('GET /api/snapshot', () => {
  /** A board with every status in it (spy world: nothing answers by itself). */
  function board() {
    h = createHarness({ world: 'spy' });
    const done = h.create({ expertiseId: 'healthcare', submit: false });
    h.cmd(done, { type: 'offer', contributorId: CHEN });
    for (const a of ['accept', 'start', 'complete'] as const) h.respond(done, a);
    const cancelled = h.create({ submit: false });
    h.cmd(cancelled, { type: 'cancel' });
    const attentionHigh = h.create({ expertiseId: 'regulatory', priority: 'high' });
    const attention = h.create({ expertiseId: 'regulatory' });
    const r1 = h.create({ priority: 'high' });
    const r2 = h.create();
    h.advance(POLICY.overdueAfterMs);
    const notRouted = h.create({ submit: false });
    const o1 = h.create({ submit: false });
    h.cmd(o1, { type: 'offer', contributorId: ANA });
    const assigned = h.create({ submit: false });
    h.cmd(assigned, { type: 'offer', contributorId: BEN });
    h.respond(assigned, 'accept');
    const working = h.create({ expertiseId: 'healthcare', submit: false });
    h.cmd(working, { type: 'offer', contributorId: CHEN });
    h.respond(working, 'accept');
    h.respond(working, 'start');
    h.advance(1 * S);
    const o2 = h.create({ expertiseId: 'healthcare', submit: false });
    h.cmd(o2, { type: 'offer', contributorId: CHEN });
    return { done, cancelled, attentionHigh, attention, r1, r2, notRouted, o1, assigned, working, o2 };
  }

  it('parses against the shared contract and carries the policy and server time', async () => {
    board();
    const snap = (await h.http.get('/api/snapshot')).body;
    parsedOk(SnapshotDto, snap);
    expect(snap.serverNow).toBe(h.clock.now());
    expect(snap.policy).toEqual(POLICY);
  });

  it('counts every column of the board exactly', async () => {
    const ids = board();
    const snap = (await h.http.get('/api/snapshot')).body;
    expect(snap.counts).toEqual({
      attention: 2,
      attentionHigh: 1,
      routing: 2,
      overdue: 2,
      offered: 2,
      nextOfferExpiry: h.active(ids.o1)!.expiresAt,
      working: 2,
      notRouted: 1,
      done: 1,
      cancelled: 1,
    });
    expect(snap.tasks.map((t: { id: number }) => t.id)).toEqual(Object.values(ids).sort((a, b) => a - b));
  });

  it('a request is counted overdue only from 20 s, and the next offer expiry is null with no offers', async () => {
    h = createHarness({ world: 'spy' });
    h.create();
    h.advance(POLICY.overdueAfterMs - 500);
    expect((await h.http.get('/api/snapshot')).body.counts).toMatchObject({ routing: 1, overdue: 0, offered: 0, nextOfferExpiry: null });
    h.advance(500);
    expect((await h.http.get('/api/snapshot')).body.counts.overdue).toBe(1);
  });

  it('contributors show their live load and the tasks they hold, sorted by name', async () => {
    const ids = board();
    const cs = (await h.http.get('/api/snapshot')).body.contributors as { name: string; load: number; maxActive: number; activeTaskIds: number[]; availability: string }[];
    expect(cs.map((c) => c.name)).toEqual(['Ana Ortiz', 'Ben Hale', 'Chen Wei']);
    expect(cs.map((c) => [c.load, c.maxActive, [...c.activeTaskIds].sort((a, b) => a - b)])).toEqual([
      [1, 1, [ids.o1]],
      [1, 1, [ids.assigned]],
      [2, 2, [ids.working, ids.o2].sort((a, b) => a - b)],
    ]);
  });

  it('expertise areas count who has them and who could be offered work right now', async () => {
    h = createHarness({ world: 'spy' });
    const area = async () => Object.fromEntries((await h.http.get('/api/snapshot')).body.expertise.map((e: { id: string }) => [e.id, e]));
    expect(await area()).toMatchObject({ finance: { contributorCount: 2, offerableCount: 2 }, healthcare: { contributorCount: 1, offerableCount: 1 }, regulatory: { contributorCount: 0, offerableCount: 0 } });
    h.app.desk.setAvailability(ANA, 'away');
    const t = h.create({ submit: false });
    h.cmd(t, { type: 'offer', contributorId: BEN });
    expect((await area()).finance).toMatchObject({ contributorCount: 2, offerableCount: 0 });
  });

  it('reports the last boot', async () => {
    h = createHarness();
    const snap = (await h.http.get('/api/snapshot')).body;
    expect(snap.lastBoot).toMatchObject({ at: T0, offlineMs: null, summary: 'Desk started.' });
    expect(snap.bootedAt).toBe(T0);
  });

  it('reads never mutate: a deadline that has passed is not enforced by a GET, only by the next tick', async () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ priority: 'high' });
    h.clock.advance(POLICY.requestDeadlineMs.high + S); // time passes with no tick
    const events = h.repo.eventCount();
    await h.http.get('/api/snapshot');
    await h.http.get(`/api/tasks/${id}`);
    await h.http.get('/api/health');
    expect(h.repo.eventCount()).toBe(events);
    expect(h.attempts(id)).toHaveLength(1);
    h.app.tick();
    expect(h.attempts(id).map((a) => a.status)).toEqual(['timed_out', 'pending']);
  });
});

describe('GET /api/tasks/:id', () => {
  it.each(named(TASK_STATES))('parses against the shared contract when %s', async (_name, s) => {
    h = createHarness({ world: 'spy' });
    const id = s.reach(h);
    const res = await h.http.get(`/api/tasks/${id}`);
    expect(res.status).toBe(200);
    parsedOk(TaskDetailDto, res.body);
    expect(res.body.status).toBe(s.status);
    expect(res.body.attention?.reason ?? null).toBe(s.attention);
    expect(res.body.events.every((e: { taskId: number }) => e.taskId === id)).toBe(true);
    const evIds = res.body.events.map((e: { id: number }) => e.id);
    expect(evIds).toEqual([...evIds].sort((a, b) => a - b));
    expect(res.body.closedAt !== null).toBe(isFinal(s.status));
  });

  it.each(['999', 'abc', '0', '-1', '1.5', '%20'])('/api/tasks/%s → 404 not_found', async (raw) => {
    h = createHarness();
    expectError(await h.http.get(`/api/tasks/${raw}`), 404, 'not_found');
  });

  it('lists candidates who can take it first, then by load, each with why not', async () => {
    h = createHarness({ world: 'spy' });
    const busy = h.create({ submit: false });
    h.cmd(busy, { type: 'offer', contributorId: ANA }); // Ana 1/1
    const id = h.create({ submit: false });
    const c = (await h.http.get(`/api/tasks/${id}`)).body.candidates;
    expect(c.map((x: { contributorId: number; blocker: string | null }) => [x.contributorId, x.blocker])).toEqual([
      [BEN, null],
      [ANA, 'at_capacity'],
    ]);
  });
});

describe('POST /api/tasks', () => {
  it('201 with the full task; ids start at T-101; the title is trimmed', async () => {
    h = createHarness();
    const res = await h.http.post('/api/tasks').send({ title: '  Expert call  ', expertiseId: 'finance', priority: 'high', sim: { engine: 'lost_always' } });
    expect(res.status).toBe(201);
    parsedOk(TaskDetailDto, res.body.task);
    expect(res.body.task).toMatchObject({ id: 101, title: 'Expert call', priority: 'high', status: 'routing' });
    const a = res.body.task.attempts[0];
    expect(a.deadlineAt - a.dispatchedAt).toBe(POLICY.requestDeadlineMs.high);
  });

  it('submit: false creates a draft that nothing routes', async () => {
    h = createHarness();
    const res = await h.http.post('/api/tasks').send({ title: 'Draft', expertiseId: 'finance', submit: false });
    expect(res.status).toBe(201);
    expect(res.body.task).toMatchObject({ status: 'new', attempts: [], wasRouted: false });
    expect(res.body.task.events.map((e: { type: string }) => e.type)).toEqual(['task_created']);
    h.advance(120 * S);
    expect(h.task(res.body.task.id).status).toBe('new');
  });

  it('a task nobody can take is still created (201) and goes straight to needs attention', async () => {
    h = createHarness();
    const res = await h.http.post('/api/tasks').send({ title: 'EU MDR pathway', expertiseId: 'regulatory' });
    expect(res.status).toBe(201);
    expect(res.body.task.attention.reason).toBe('no_eligible_contributors');
  });

  it.each([
    [{ title: 'ab', expertiseId: 'finance' }, 'title'],
    [{ title: 'Valid', expertiseId: '' }, 'expertiseId'],
    [{ title: 'Valid', expertiseId: 'finance', priority: 'urgent' }, 'priority'],
    [{ title: 'Valid', expertiseId: 'finance', sim: { engine: 'psychic' } }, 'sim'],
    [{ title: 'Valid', expertiseId: 'finance', status: 'completed' }, null],
  ])('400 validation_failed for %j', async (body, field) => {
    h = createHarness();
    const res = await h.http.post('/api/tasks').send(body);
    expectError(res, 400, 'validation_failed');
    if (field) expect(res.body.error.issues[0].path[0]).toBe(field);
    expect(h.repo.listTasks()).toEqual([]);
  });

  it.each([
    ['malformed JSON', '{"title": "x",', 'application/json'],
    ['the JSON literal null', 'null', 'application/json'],
    ['a JSON array', '[1,2]', 'application/json'],
    ['a non-JSON content type', 'title=Valid', 'application/x-www-form-urlencoded'],
  ])('400 for %s', async (_label, raw, type) => {
    h = createHarness();
    const res = await h.http.post('/api/tasks').set('content-type', type).send(raw);
    expectError(res, 400, 'validation_failed');
    expect(h.repo.listTasks()).toEqual([]);
  });

  it('422 for an unknown expertise area, and nothing is created', async () => {
    h = createHarness();
    expectError(await h.http.post('/api/tasks').send({ title: 'Valid', expertiseId: 'astrology' }), 422, 'invalid_expertise');
    expect(h.repo.listTasks()).toEqual([]);
  });

  it('a body over the size limit or in an unsupported charset is a client error (4xx), not a 500 "something went wrong"', async () => {
    h = createHarness();
    const big = await h.http.post('/api/tasks').set('content-type', 'application/json').send(JSON.stringify({ title: 'x'.repeat(200_000), expertiseId: 'finance' }));
    expect(big.status, JSON.stringify(big.body)).toBe(413);
    const charset = await h.http.post('/api/tasks').set('content-type', 'application/json; charset=latin9').send('{"title":"Valid","expertiseId":"finance"}');
    expect(charset.status, JSON.stringify(charset.body)).toBe(415);
  });
});

describe('POST /api/tasks/:id/commands', () => {
  it('200 with the updated task', async () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    const res = await h.http.post(`/api/tasks/${id}/commands`).send({ type: 'stop_routing', expectedVersion: h.task(id).version });
    expect(res.status).toBe(200);
    parsedOk(TaskDetailDto, res.body.task);
    expect(res.body.task.status).toBe('new');
  });

  it('404 for an unknown task (with a valid body)', async () => {
    h = createHarness();
    expectError(await h.http.post('/api/tasks/999/commands').send({ type: 'cancel', expectedVersion: 1 }), 404, 'not_found');
    expectError(await h.http.post('/api/tasks/abc/commands').send({ type: 'cancel', expectedVersion: 1 }), 404, 'not_found');
  });

  it('400 for an invalid body, checked before the task is looked up', async () => {
    h = createHarness();
    expectError(await h.http.post('/api/tasks/999/commands').send({ type: 'cancel' }), 400, 'validation_failed');
    expectError(await h.http.post('/api/tasks/999/commands').send({ type: 'teleport', expectedVersion: 1 }), 400, 'validation_failed');
  });

  it('409 version_conflict lists exactly the events the operator has not seen, and the current task', async () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    const seen = (await h.http.get(`/api/tasks/${id}`)).body;
    h.deliver(id, 1, { kind: 'match', contributorId: ANA });
    h.respond(id, 'accept');
    const res = await h.http.post(`/api/tasks/${id}/commands`).send({ type: 'cancel', expectedVersion: seen.version, seenEventId: seen.events.at(-1).id });
    expectError(res, 409, 'version_conflict');
    expect(res.body.error.unseen.map((e: { type: string }) => e.type)).toEqual(['attempt_matched', 'offer_created', 'offer_accepted']);
    parsedOk(TaskDetailDto, res.body.error.task);
    expect(res.body.error.task.status).toBe('assigned');
    expect(h.task(id).status).toBe('assigned');
  });

  it('409 contributor_unavailable says why: away, or at capacity', async () => {
    h = createHarness({ world: 'spy' });
    h.app.desk.setAvailability(BEN, 'away');
    const busy = h.create({ submit: false });
    h.cmd(busy, { type: 'offer', contributorId: ANA });
    const id = h.create({ submit: false });
    const away = await h.http.post(`/api/tasks/${id}/commands`).send({ type: 'offer', contributorId: BEN, expectedVersion: h.task(id).version });
    expectError(away, 409, 'contributor_unavailable');
    expect(away.body.error).toMatchObject({ reason: 'away', task: { id } });
    const full = await h.http.post(`/api/tasks/${id}/commands`).send({ type: 'offer', contributorId: ANA, expectedVersion: h.task(id).version });
    expect(full.body.error).toMatchObject({ code: 'contributor_unavailable', reason: 'at_capacity' });
    expect(full.body.error.message).toMatch(/1\/1/);
  });

  it('commands are judged against the current world: a deadline that passed without a tick is enforced first', async () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ submit: false });
    h.cmd(id, { type: 'offer', contributorId: ANA });
    const v = h.task(id).version;
    h.clock.advance(POLICY.offerTtlMs + S); // the offer has expired, but no tick has run
    const res = await h.http.post(`/api/tasks/${id}/commands`).send({ type: 'revoke_offer', expectedVersion: v });
    expectError(res, 409, 'version_conflict');
    expect(res.body.error.task.attention.reason).toBe('offer_expired');
  });
});

describe('POST /api/sim/assignments/:id/respond', () => {
  it('200 with the task; the history marks it as a simulation click', async () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ submit: false });
    h.cmd(id, { type: 'offer', contributorId: ANA });
    const res = await h.http.post(`/api/sim/assignments/${h.active(id)!.id}/respond`).send({ action: 'decline', note: 'Busy' });
    expect(res.status).toBe(200);
    parsedOk(TaskDetailDto, res.body.task);
    expect(res.body.task.attention.reason).toBe('declined');
    expect(res.body.task.events.at(-1).payload).toMatchObject({ simulatedBy: 'button', note: 'Busy' });
  });

  it.each(['999', 'abc', '0'])('404 for assignment %s', async (raw) => {
    h = createHarness();
    expectError(await h.http.post(`/api/sim/assignments/${raw}/respond`).send({ action: 'accept' }), 404, 'not_found');
  });

  it('400 for an action that does not exist', async () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ submit: false });
    h.cmd(id, { type: 'offer', contributorId: ANA });
    expectError(await h.http.post(`/api/sim/assignments/${h.active(id)!.id}/respond`).send({ action: 'ghost' }), 400, 'validation_failed');
    expect(h.task(id).status).toBe('offered');
  });

  it('409 assignment_not_active when the assignment has ended; the attempt is recorded once', async () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ submit: false });
    h.cmd(id, { type: 'offer', contributorId: ANA });
    const asg = h.active(id)!.id;
    h.cmd(id, { type: 'cancel', note: 'Client paused the project' });
    const res = await h.http.post(`/api/sim/assignments/${asg}/respond`).send({ action: 'accept' });
    expectError(res, 409, 'assignment_not_active');
    expect(res.body.error.task.status).toBe('cancelled');
    expect(h.types(id).filter((t) => t === 'late_response_ignored')).toHaveLength(1);
  });
});

describe('POST /api/sim/attempts/:id/deliver', () => {
  it('a match for the pending request is applied', async () => {
    h = createHarness();
    const id = h.create({ engine: 'lost_always' });
    const res = await h.http.post(`/api/sim/attempts/${h.attempts(id)[0].id}/deliver`).send({ outcome: 'match', contributorId: BEN });
    expect(res.status).toBe(200);
    parsedOk(DeliverResultDto, res.body);
    expect(res.body).toMatchObject({ applied: true, reason: 'applied', task: { status: 'offered', activeAssignment: { contributorId: BEN, source: 'engine' } } });
  });

  it('a no-match the desk acts on is reported consistently: the response agrees with the request’s own result', async () => {
    h = createHarness();
    const id = h.create({ engine: 'lost_always' });
    const res = await h.http.post(`/api/sim/attempts/${h.attempts(id)[0].id}/deliver`).send({ outcome: 'no_match' });
    expect(res.status).toBe(200);
    expect(res.body.task.attention.reason).toBe('no_match');
    expect(res.body.task.attempts[0].result.applied).toBe(true);
    expect(res.body.applied, `deliver said ${JSON.stringify({ applied: res.body.applied, reason: res.body.reason })}`).toBe(res.body.task.attempts[0].result.applied);
  });

  it('delivering to a request that has already answered changes nothing (duplicate)', async () => {
    h = createHarness();
    const id = h.create({ engine: 'lost_always' });
    const attemptId = h.attempts(id)[0].id;
    await h.http.post(`/api/sim/attempts/${attemptId}/deliver`).send({ outcome: 'match', contributorId: ANA });
    const before = JSON.stringify({ t: h.task(id), a: h.repo.assignmentsForTask(id), n: h.repo.eventCount() });
    const res = await h.http.post(`/api/sim/attempts/${attemptId}/deliver`).send({ outcome: 'match', contributorId: BEN });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: false, reason: 'duplicate' });
    expect(res.body.task.sim.deliverableAttemptIds).not.toContain(attemptId);
    expect(JSON.stringify({ t: h.task(id), a: h.repo.assignmentsForTask(id), n: h.repo.eventCount() })).toBe(before);
  });

  it('delivering to a request we stopped waiting for is recorded as a late answer, not applied', async () => {
    h = createHarness();
    const id = h.create({ engine: 'lost_always', priority: 'high' });
    h.advance(POLICY.requestDeadlineMs.high);
    const first = h.attempts(id)[0].id;
    const res = await h.http.post(`/api/sim/attempts/${first}/deliver`).send({ outcome: 'match', contributorId: ANA });
    expect(res.body).toMatchObject({ applied: false, reason: 'late', task: { status: 'routing' } });
    expect(res.body.task.lateAnswers).toEqual([expect.objectContaining({ attemptSeq: 1, contributorId: ANA, offerableNow: true })]);
  });

  it('a pick outside the request is not applied and uses a retry', async () => {
    h = createHarness();
    const id = h.create({ engine: 'lost_always' });
    const res = await h.http.post(`/api/sim/attempts/${h.attempts(id)[0].id}/deliver`).send({ outcome: 'match', contributorId: CHEN });
    expect(res.body).toMatchObject({ applied: false, reason: 'invalid_result' });
    expect(res.body.task.attempts.map((a: { status: string }) => a.status)).toEqual(['invalid_result', 'pending']);
  });

  it('404 for an unknown request or an unknown contributor; 400 for a match without a contributor', async () => {
    h = createHarness();
    const id = h.create({ engine: 'lost_always' });
    const attemptId = h.attempts(id)[0].id;
    expectError(await h.http.post('/api/sim/attempts/999/deliver').send({ outcome: 'no_match' }), 404, 'not_found');
    expectError(await h.http.post(`/api/sim/attempts/${attemptId}/deliver`).send({ outcome: 'match', contributorId: 999 }), 404, 'not_found');
    expectError(await h.http.post(`/api/sim/attempts/${attemptId}/deliver`).send({ outcome: 'match' }), 400, 'validation_failed');
    expect(h.task(id).status).toBe('routing');
  });

  it('409 sim_disabled when no simulator is running', async () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    expectError(await h.http.post(`/api/sim/attempts/${h.attempts(id)[0].id}/deliver`).send({ outcome: 'no_match' }), 409, 'sim_disabled');
    expect(h.task(id).status).toBe('routing');
  });
});

describe('PATCH /api/sim/contributors/:id', () => {
  it('marks a contributor away: new routing leaves them out, existing offers are untouched, and it is recorded once', async () => {
    h = createHarness({ world: 'spy' });
    const held = h.create({ submit: false });
    h.cmd(held, { type: 'offer', contributorId: ANA });
    const res = await h.http.patch(`/api/sim/contributors/${ANA}`).send({ availability: 'away' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    await h.http.patch(`/api/sim/contributors/${ANA}`).send({ availability: 'away' }); // no-op
    const changes = h.repo.systemEventsSince(0).filter((e) => e.type === 'contributor_availability_changed');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ actor: 'simulator', contributorId: ANA, taskId: null });
    expect(h.active(held)!.status).toBe('offered');

    const id = h.create();
    expect(h.attempts(id)[0].candidates.map((c) => c.contributorId)).toEqual([BEN]);
    const d = (await h.http.get(`/api/tasks/${id}`)).body;
    expect(d.candidates.find((c: { contributorId: number }) => c.contributorId === ANA)).toMatchObject({ availability: 'away', blocker: 'away' });
  });

  it('marking them available again brings them back into routing', async () => {
    h = createHarness({ world: 'spy' });
    await h.http.patch(`/api/sim/contributors/${BEN}`).send({ availability: 'away' });
    await h.http.patch(`/api/sim/contributors/${BEN}`).send({ availability: 'available' });
    const id = h.create();
    expect(h.attempts(id)[0].candidates.map((c) => c.contributorId).sort()).toEqual([ANA, BEN]);
  });

  it('404 for an unknown contributor, 400 for an invalid availability', async () => {
    h = createHarness();
    expectError(await h.http.patch('/api/sim/contributors/999').send({ availability: 'away' }), 404, 'not_found');
    expectError(await h.http.patch('/api/sim/contributors/abc').send({ availability: 'away' }), 404, 'not_found');
    expectError(await h.http.patch(`/api/sim/contributors/${ANA}`).send({ availability: 'busy' }), 400, 'validation_failed');
  });
});

describe('POST /api/sim/reset', () => {
  it('replaces everything with the demo seed (T-101…T-113), records the reset, and keeps every invariant', async () => {
    h = createHarness();
    h.create({ engine: 'quick_match' });
    h.create({ engine: 'quick_match' });
    h.advance(10 * S);
    const res = await h.http.post('/api/sim/reset');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const snap = (await h.http.get('/api/snapshot')).body;
    parsedOk(SnapshotDto, snap);
    expect(snap.tasks.map((t: { id: number }) => t.id)).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113]);
    expect(h.repo.lastEventOfTypes(['desk_reset'])).toBeTruthy();
    expect(checkInvariants(h.sql)).toEqual([]);
    expect(snap.contributors).toHaveLength(8);
  });

  it('without a simulator the seed has no live tasks', async () => {
    h = createHarness({ world: 'spy' });
    await h.http.post('/api/sim/reset');
    const snap = (await h.http.get('/api/snapshot')).body;
    expect(snap.tasks.map((t: { id: number }) => t.id)).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]);
    expect(snap.counts.routing).toBe(0);
  });

  it('calls the onReset hook once', async () => {
    const sql = openDb(':memory:');
    let resets = 0;
    const app = createApp({ sql, clock: new FakeClock(T0), seed: 'x', onReset: () => resets++ });
    app.boot();
    try {
      expect((await request(app.http).post('/api/sim/reset')).status).toBe(200);
      expect(resets).toBe(1);
    } finally {
      sql.close();
    }
  });
});

describe('unknown endpoints', () => {
  it.each([
    ['get', '/api/nope'],
    ['post', '/api/nope'],
    ['delete', '/api/tasks/101'],
    ['put', '/api/tasks/101'],
    ['patch', '/api/tasks/101'],
    ['get', '/api/tasks/101/commands'],
    ['get', '/api/sim/reset'],
    ['post', '/api/snapshot'],
  ] as const)('%s %s → 404 "No such endpoint"', async (method, path) => {
    h = createHarness();
    const res = await h.http[method](path);
    expectError(res, 404, 'not_found');
    expect(res.body.error.message).toBe('No such endpoint');
  });

  it('does not advertise the framework', async () => {
    h = createHarness();
    expect((await h.http.get('/api/health')).headers['x-powered-by']).toBeUndefined();
  });
});

describe('a genuine fault is a 500 with an errorId, and nothing is half-written (R13)', () => {
  it('if the engine port throws while a task is created and submitted, the whole action rolls back', async () => {
    h = createHarness({ world: 'spy' });
    const events = h.repo.eventCount();
    h.app.spy!.engine.dispatch = () => {
      throw new Error('engine port exploded');
    };
    const res = await h.http.post('/api/tasks').send({ title: 'Doomed task', expertiseId: 'finance' });
    expectError(res, 500, 'internal');
    expect(res.body.error.errorId).toMatch(/^[0-9a-f]{1,6}$/);
    expect(res.body.error.message).toContain(res.body.error.errorId);
    expect(res.body.error.message).not.toMatch(/exploded/); // internals are logged, not shown
    expect(h.repo.listTasks()).toEqual([]);
    expect(h.repo.eventCount()).toBe(events);
  });

  it('a broken invariant inside a command is reported as invariant_violation and rolled back', async () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ submit: false });
    // Simulated corruption written behind the desk's back: "offered" with no offer row.
    h.sql.run(`UPDATE tasks SET status = 'offered' WHERE id = ?`, id);
    const events = h.repo.eventCount();
    const res = await h.http.post(`/api/tasks/${id}/commands`).send({ type: 'revoke_offer', expectedVersion: h.task(id).version });
    expectError(res, 500, 'invariant_violation');
    expect(res.body.error.errorId).toBeTruthy();
    expect(h.repo.eventCount()).toBe(events);
    expect(h.task(id).status).toBe('offered');
  });
});

// ── R12 ─────────────────────────────────────────────────────────────────────

const FORBIDDEN_KEY = /fate|planned|scenario|preset|dueIn|due_?at|never|willAnswer|answerKey/i;
const PRESET_IDS = [...ENGINE_PRESETS.map((p) => p.id), ...CONTRIBUTOR_PRESETS.map((p) => p.id)].filter((id) => id.includes('_') && id !== 'no_match');

function leaks(value: unknown, path = '$', out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v, i) => leaks(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(k)) out.push(`${path}.${k}`);
      leaks(v, `${path}.${k}`, out);
    }
  } else if (typeof value === 'string') {
    for (const p of PRESET_IDS) if (value.includes(p)) out.push(`${path} mentions ${p}`);
  }
  return out;
}

describe('R12: no response reveals a request’s planned fate', () => {
  it('(the scanner used below does catch a leak)', () => {
    expect(leaks({ task: { attempts: [{ dueAt: 1, plannedFate: 'x' }], note: 'lost_always' } })).toEqual(['$.task.attempts[0].dueAt', '$.task.attempts[0].plannedFate', '$.task.note mentions lost_always']);
  });

  it('across every engine × contributor preset and many points in time, no key or value in any response gives the plan away', async () => {
    h = createHarness();
    let n = 0;
    for (const e of ENGINE_PRESETS) {
      for (const c of CONTRIBUTOR_PRESETS) {
        await h.http.post('/api/tasks').send({ title: `Task number ${++n}`, expertiseId: e.id === 'realistic' ? 'healthcare' : 'finance', priority: 'high', sim: { engine: e.id, contributor: c.id } });
      }
    }
    const found: string[] = [];
    for (const step of [0, 5 * S, 7 * S, 15 * S, 25 * S, 35 * S, 45 * S, 95 * S]) {
      h.advance(step);
      const snap = (await h.http.get('/api/snapshot')).body;
      found.push(...leaks(snap, 'snapshot'));
      found.push(...leaks((await h.http.get('/api/activity?limit=200')).body, 'activity'));
      found.push(...leaks((await h.http.get('/api/health')).body, 'health'));
      for (const t of snap.tasks) found.push(...leaks((await h.http.get(`/api/tasks/${t.id}`)).body, `T-${t.id}`));
    }
    expect([...new Set(found)]).toEqual([]);
  });

  it('a request that will answer late, one that answers on the retry, and one that never answers look identical while pending', async () => {
    h = createHarness();
    const ids: number[] = [];
    for (const engine of ['late_answer', 'lost_once', 'lost_always']) {
      ids.push((await h.http.post('/api/tasks').send({ title: 'Same task', expertiseId: 'finance', priority: 'high', sim: { engine } })).body.task.id);
    }
    const strip = (d: unknown) => JSON.parse(JSON.stringify(d, (k, v) => (['id', 'taskId', 'attemptId', 'attemptIds', 'deliverableAttemptIds'].includes(k) ? '·' : v)));
    for (const step of [0, 10 * S, 10 * S, 9.5 * S]) {
      h.advance(step);
      const [a, b, c] = await Promise.all(ids.map(async (id) => strip((await h.http.get(`/api/tasks/${id}`)).body)));
      expect(b).toEqual(a);
      expect(c).toEqual(a);
    }
  });

  it('while its only request is pending (even Overdue), nothing the API says about the task calls it stuck, failed or lost', async () => {
    h = createHarness();
    const id = (await h.http.post('/api/tasks').send({ title: 'Clinician panel', expertiseId: 'healthcare', priority: 'low', sim: { engine: 'lost_always' } })).body.task.id;
    for (const step of [0, 10 * S, 15 * S, 30 * S]) {
      h.advance(step);
      const body = JSON.stringify((await h.http.get(`/api/tasks/${id}`)).body);
      expect(body).not.toMatch(/\b(stuck|failed|lost)\b/i);
    }
    expect(h.attempts(id)).toHaveLength(1);
  });
});

describe('hardening found by this suite', () => {
  it('task ids are plain decimal integers: hex, exponent and padded forms are 404, not T-101', async () => {
    h = createHarness();
    const id = h.create({ submit: false });
    expect((await h.http.get(`/api/tasks/${id}`)).status).toBe(200);
    for (const raw of [`0x${id.toString(16)}`, `${id / 100}e2`, `%20${id}`, `0${id}`, `${id}.0`]) {
      expect((await h.http.get(`/api/tasks/${raw}`)).status, raw).toBe(404);
    }
  });

  it('release needs a reason in the domain too, not only over HTTP', () => {
    h = createHarness();
    const id = h.create({ submit: false });
    h.cmd(id, { type: 'offer', contributorId: ANA });
    h.respond(id, 'accept');
    const before = h.task(id);
    expect(() => h.cmd(id, { type: 'release', note: '' })).toThrow(/Say why/);
    expect(h.task(id)).toEqual(before);
  });
});

describe('response headers', () => {
  it('every API response is hardened and never cached', async () => {
    h = createHarness();
    for (const res of [await h.http.get('/api/snapshot'), await h.http.get('/api/tasks/999'), await h.http.post('/api/tasks').send({})]) {
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-powered-by']).toBeUndefined();
    }
  });
});
