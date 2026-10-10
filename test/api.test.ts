// HTTP contract: validation, errors, the shared schemas, and the "operator cannot know" property.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, S, ANA, type Harness } from './helpers/harness';
import { ApiErrorDto, SnapshotDto, TaskDetailDto } from '../src/shared/schemas';

let h: Harness;
afterEach(() => h?.close());

describe('API', () => {
  it('creates and submits a task in one request', async () => {
    h = createHarness();
    const res = await h.http.post('/api/tasks').send({ title: 'Expert call: CFO tooling', expertiseId: 'finance', priority: 'high', submit: true, sim: { engine: 'quick_match', contributor: 'accept' } });
    expect(res.status).toBe(201);
    expect(TaskDetailDto.safeParse(res.body.task).success).toBe(true);
    expect(res.body.task.status).toBe('routing');
    expect(res.body.task.nextAutomaticAction).toMatchObject({ kind: 'retry_routing', nextRequest: 2, requestsPerRound: 3 });
  });

  it('rejects invalid input with 400 and the failing path', async () => {
    h = createHarness();
    const res = await h.http.post('/api/tasks').send({ title: '', expertiseId: 'finance' });
    expect(res.status).toBe(400);
    expect(ApiErrorDto.safeParse(res.body).success).toBe(true);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.issues[0].path).toEqual(['title']);

    expect((await h.http.post('/api/tasks').send({ title: 'Valid title', expertiseId: 'finance', extra: 1 })).status).toBe(400);
    expect((await h.http.post('/api/tasks').set('content-type', 'application/json').send('{bad json')).status).toBe(400);
    const unknownArea = await h.http.post('/api/tasks').send({ title: 'Valid title', expertiseId: 'astrology' });
    expect(unknownArea.status).toBe(422);
    const release = await h.http.post(`/api/tasks/101/commands`).send({ type: 'release', expectedVersion: 1 });
    expect(release.status).toBe(400); // release requires a note
  });

  it('returns 404 for unknown tasks, assignments and endpoints', async () => {
    h = createHarness();
    expect((await h.http.get('/api/tasks/999')).status).toBe(404);
    expect((await h.http.get('/api/tasks/abc')).status).toBe(404);
    expect((await h.http.post('/api/sim/assignments/999/respond').send({ action: 'accept' })).status).toBe(404);
    expect((await h.http.get('/api/nope')).status).toBe(404);
  });

  it('a slow request and a never-returning one look identical to the operator', async () => {
    h = createHarness();
    const slow = (await h.http.post('/api/tasks').send({ title: 'Same task', expertiseId: 'finance', priority: 'normal', sim: { engine: 'late_answer' } })).body.task.id;
    const lost = (await h.http.post('/api/tasks').send({ title: 'Same task', expertiseId: 'finance', priority: 'normal', sim: { engine: 'lost_always' } })).body.task.id;
    h.advance(25 * S); // both overdue, neither answered
    const a = (await h.http.get(`/api/tasks/${slow}`)).body;
    const b = (await h.http.get(`/api/tasks/${lost}`)).body;
    const strip = (d: Record<string, unknown>) => JSON.parse(JSON.stringify(d, (k, v) => (['id', 'taskId', 'attemptId', 'version', 'deliverableAttemptIds'].includes(k) ? '·' : v)));
    expect(strip(a)).toEqual(strip(b));
    const snap = (await h.http.get('/api/snapshot')).body;
    const rows = snap.tasks.filter((t: { id: number }) => t.id === slow || t.id === lost).map(strip);
    expect(rows[0]).toEqual(rows[1]);
    expect(JSON.stringify(snap)).not.toMatch(/late_answer|lost_always|sim_jobs|due_at/);
  });

  it('simulation endpoints: respond as a contributor, deliver an answer now, toggle availability', async () => {
    h = createHarness();
    const id = (await h.http.post('/api/tasks').send({ title: 'Sim task', expertiseId: 'finance', sim: { engine: 'lost_always' } })).body.task.id;
    const attemptId = h.attempts(id)[0].id;
    const d = await h.http.post(`/api/sim/attempts/${attemptId}/deliver`).send({ outcome: 'match', contributorId: ANA });
    expect(d.body).toMatchObject({ applied: true, reason: 'applied' });
    expect(d.body.task.status).toBe('offered');
    expect(d.body.task.events.find((e: { type: string }) => e.type === 'attempt_matched').payload.simulatedBy).toBe('button');

    const asg = d.body.task.activeAssignment.id;
    const r = await h.http.post(`/api/sim/assignments/${asg}/respond`).send({ action: 'accept' });
    expect(r.status).toBe(200);
    expect(r.body.task.status).toBe('assigned');
    const again = await h.http.post(`/api/sim/assignments/${asg}/respond`).send({ action: 'decline' });
    expect(again.status).toBe(409);

    expect((await h.http.patch(`/api/sim/contributors/${ANA}`).send({ availability: 'away' })).status).toBe(200);
    const snap = (await h.http.get('/api/snapshot')).body;
    expect(SnapshotDto.safeParse(snap).success).toBe(true);
    expect(snap.contributors.find((c: { id: number }) => c.id === ANA).availability).toBe('away');
  });

  it('reset wipes everything and reloads the demo seed, twice in a row, with invariants intact', async () => {
    h = createHarness();
    h.create({ engine: 'quick_match' });
    for (let i = 0; i < 2; i++) {
      expect((await h.http.post('/api/sim/reset')).status).toBe(200);
      const snap = (await h.http.get('/api/snapshot')).body;
      expect(SnapshotDto.safeParse(snap).success).toBe(true);
      expect(snap.tasks.map((t: { id: number }) => t.id)).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113]);
      h.assertInvariants();
    }
    h.advance(7 * S); // the live quick-match task still routes after a reset
    expect(h.task(113).status).toBe('offered');
  });

  it('health reports the boot and the last tick', async () => {
    h = createHarness();
    const res = await h.http.get('/api/health');
    expect(res.body).toMatchObject({ ok: true, serverNow: h.clock.now(), lastTickAt: h.clock.now() });
  });
});
