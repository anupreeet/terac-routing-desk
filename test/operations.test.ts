// The "state of the operation" and desk-wide history: engine health counts and the activity feed.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, S, ANA, type Harness } from './helpers/harness';
import { ActivityDto, ApiErrorDto, EngineHealthDto, SnapshotDto } from '../src/shared/schemas';
import { POLICY } from '../src/shared/policy';

let h: Harness;
afterEach(() => h?.close());

const engine = async () => (await h.http.get('/api/snapshot')).body.engine as EngineHealthDto;

describe('engine health', () => {
  it('starts empty and is part of the snapshot contract', async () => {
    h = createHarness();
    const snap = (await h.http.get('/api/snapshot')).body;
    expect(SnapshotDto.safeParse(snap).success).toBe(true);
    expect(snap.engine).toEqual({
      windowMs: POLICY.engineHealthWindowMs,
      sent: 0,
      pending: 0,
      overdue: 0,
      answered: 0,
      matched: 0,
      noMatch: 0,
      notApplied: 0,
      noAnswerByDeadline: 0,
      stoppedByOperator: 0,
      lateAnswers: 0,
      medianAnswerMs: null,
      p90AnswerMs: null,
    });
  });

  it('counts pending requests and marks them overdue only after the overdue threshold', async () => {
    h = createHarness();
    h.create({ engine: 'lost_always', priority: 'low' });
    h.create({ engine: 'lost_always', priority: 'low', expertiseId: 'healthcare' });
    expect(await engine()).toMatchObject({ sent: 2, pending: 2, overdue: 0 });
    h.advance(POLICY.overdueAfterMs - S);
    expect((await engine()).overdue).toBe(0);
    h.advance(S);
    expect((await engine()).overdue).toBe(2);
  });

  it('measures answer time only for requests answered before the deadline', async () => {
    h = createHarness();
    h.create({ engine: 'quick_match' }); // answers at 6 s
    h.advance(7 * S);
    const e = await engine();
    expect(e).toMatchObject({ sent: 1, pending: 0, answered: 1, matched: 1, medianAnswerMs: 6 * S, p90AnswerMs: 6 * S });
  });

  it('separates "no answer by the deadline", late answers and operator stops', async () => {
    h = createHarness();
    const late = h.create({ engine: 'late_answer', priority: 'high' }); // #1 answers at 40 s, after the 30 s deadline
    h.advance(31 * S);
    expect(await engine()).toMatchObject({ noAnswerByDeadline: 1, lateAnswers: 0, pending: 1 });
    h.advance(10 * S); // #1's late answer arrives; #2 (sent at 30 s) answered at 36 s
    const e = await engine();
    expect(e).toMatchObject({ sent: 2, noAnswerByDeadline: 1, lateAnswers: 1, matched: 1 });
    expect(h.task(late).status).toBe('offered');

    const stopped = h.create({ engine: 'lost_always' });
    h.cmd(stopped, { type: 'stop_routing' });
    expect((await engine()).stoppedByOperator).toBe(1);
  });

  it('counts a "no match" answer as answered, not as a match', async () => {
    h = createHarness();
    h.create({ engine: 'no_match' });
    h.advance(9 * S);
    expect(await engine()).toMatchObject({ answered: 1, noMatch: 1, matched: 0 });
  });

  it('forgets requests sent before the window', async () => {
    h = createHarness();
    h.create({ engine: 'quick_match' });
    h.advance(7 * S);
    expect((await engine()).sent).toBe(1);
    h.jump(POLICY.engineHealthWindowMs);
    expect((await engine()).sent).toBe(0);
  });

  it('is identical for a slow request and a never-returning one (it counts, never predicts)', async () => {
    h = createHarness();
    h.create({ engine: 'late_answer', priority: 'low' });
    h.advance(25 * S);
    const slow = await engine();
    h.close();
    h = createHarness();
    h.create({ engine: 'lost_always', priority: 'low' });
    h.advance(25 * S);
    expect(await engine()).toEqual(slow);
  });
});

describe('activity feed', () => {
  it('lists events across the desk, newest first, with the task title', async () => {
    h = createHarness();
    const a = h.create({ title: 'First task', engine: 'lost_always' });
    const b = h.create({ title: 'Second task', engine: 'lost_always', expertiseId: 'healthcare' });
    const res = await h.http.get('/api/activity');
    expect(res.status).toBe(200);
    expect(ActivityDto.safeParse(res.body).success).toBe(true);
    const ids = res.body.events.map((e: { id: number }) => e.id);
    expect(ids).toEqual([...ids].sort((x, y) => y - x));
    expect(res.body.events[0].taskId).toBe(b);
    expect(res.body.events.find((e: { taskId: number }) => e.taskId === a).taskTitle).toBe('First task');
    expect(res.body.events.find((e: { taskId: number }) => e.taskId === b).taskTitle).toBe('Second task');
  });

  it('includes desk-level events without a task', async () => {
    h = createHarness();
    const res = await h.http.get('/api/activity');
    const boot = res.body.events.find((e: { type: string }) => e.type === 'desk_started' || e.type === 'desk_restarted');
    expect(boot).toBeDefined();
    expect(boot.taskId).toBeNull();
    expect(boot.taskTitle).toBeNull();
  });

  it('pages backwards with ?before until there is nothing older', async () => {
    h = createHarness();
    for (let i = 0; i < 6; i++) h.create({ title: `Task ${i}`, engine: 'lost_always', submit: false });
    const seen: number[] = [];
    let before: number | null = null;
    let pages = 0;
    do {
      const res = await h.http.get(`/api/activity?limit=4${before ? `&before=${before}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.events.length).toBeLessThanOrEqual(4);
      seen.push(...res.body.events.map((e: { id: number }) => e.id));
      before = res.body.nextBefore;
      pages++;
    } while (before !== null && pages < 20);
    expect(new Set(seen).size).toBe(seen.length); // no duplicates across pages
    expect(seen.length).toBe(h.repo.eventCount()); // and nothing missed
    expect(seen).toEqual([...seen].sort((x, y) => y - x));
  });

  it('returns nextBefore = null when everything fits', async () => {
    h = createHarness();
    const res = await h.http.get('/api/activity?limit=200');
    expect(res.body.nextBefore).toBeNull();
  });

  it.each([['limit=0'], ['limit=201'], ['limit=abc'], ['before=-1'], ['before=0'], ['unknown=1']])('rejects an invalid query (%s) with 400', async (q) => {
    h = createHarness();
    const res = await h.http.get(`/api/activity?${q}`);
    expect(res.status).toBe(400);
    expect(ApiErrorDto.safeParse(res.body).success).toBe(true);
  });

  it('shows ignored late answers so the operator can see what the engine said', async () => {
    h = createHarness();
    const id = h.create({ engine: 'late_answer', priority: 'normal' });
    h.advance(20 * S);
    h.cmd(id, { type: 'offer', contributorId: ANA });
    h.advance(25 * S); // request #1 answers at 40 s, after the operator's offer
    const res = await h.http.get('/api/activity');
    const ignored = res.body.events.find((e: { type: string; taskId: number }) => e.type === 'late_result_ignored' && e.taskId === id);
    expect(ignored).toBeDefined();
    expect(ignored.summary).toMatch(/not applied/i);
  });
});
