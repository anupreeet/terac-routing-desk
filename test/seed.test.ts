import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Sql } from '../src/server/infra/db';
import { FakeClock } from '../src/server/infra/clock';
import { createApp } from '../src/server/app';
import { seedDemo } from '../src/server/seed/seed';
import { checkInvariants } from '../src/server/infra/invariants';
import { SnapshotDto } from '../src/shared/schemas';

let sql: Sql;
afterEach(() => sql?.close());

describe('demo seed', () => {
  it('replays real commands into every board state, with valid invariants and live tasks', () => {
    sql = openDb(':memory:');
    const now = Date.UTC(2026, 9, 4, 15, 0, 0);
    const app = createApp({ sql, clock: new FakeClock(now) });
    seedDemo(app, now);
    app.boot(now);
    expect(checkInvariants(sql)).toEqual([]);

    const s = app.views.snapshot(now, app.bootInfo);
    expect(SnapshotDto.safeParse(s).success).toBe(true);
    const byId = Object.fromEntries(s.tasks.map((t) => [t.id, t]));
    expect(byId[101].status).toBe('completed');
    expect(byId[102].status).toBe('in_progress');
    expect(byId[103].status).toBe('assigned');
    expect(byId[104].attention?.reason).toBe('declined');
    expect(byId[105].attention?.reason).toBe('routing_exhausted');
    expect(byId[106].attention?.reason).toBe('failed_before_start');
    expect(byId[107].status).toBe('in_progress');
    expect(byId[108].status).toBe('cancelled');
    expect([byId[109].status, byId[110].status, byId[111].status]).toEqual(['new', 'new', 'new']);
    expect(byId[112].status).toBe('routing'); // live: never answers
    expect(byId[113].status).toBe('routing'); // live: quick match

    // Seeded history is what the system writes, including late answers recorded and ignored.
    const d102 = app.views.taskDetail(102)!;
    expect(d102.events.map((e) => e.type)).toContain('late_result_ignored');
    expect(app.views.taskDetail(105)!.lateAnswers).toHaveLength(1);
    // T-104's recovery panel: Priya excluded, Lena full, Fatima free.
    const c104 = app.views.taskDetail(104)!.candidates;
    expect(c104.find((c) => c.name === 'Priya Raman')!.blocker).toBe('excluded');
    expect(c104.find((c) => c.name === 'Lena Fischer')!.blocker).toBe('at_capacity');
    expect(c104.find((c) => c.name === 'Fatima Al-Sayed')!.blocker).toBeNull();
  });
});
