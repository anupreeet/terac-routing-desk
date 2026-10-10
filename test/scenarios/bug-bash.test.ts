// Findings from the adversarial API/server bug bash (docs/CORRECTIONS.md C-8). Each test failed, or
// could not be written, before its fix. The real-process checks (second instance, bad PORT) are in
// e2e/process.spec.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { ANA, createHarness, S, T0, type Harness } from '../helpers/harness';
import { openDb, resetDb, seedState, type Sql } from '../../src/server/infra/db';
import { acquireLock, lockPath } from '../../src/server/infra/lock';
import { FakeClock } from '../../src/server/infra/clock';
import { createApp } from '../../src/server/app';
import { createRepo } from '../../src/server/store/repo';
import { seedDemo } from '../../src/server/seed/seed';
import { checkInvariants } from '../../src/server/infra/invariants';
import { POLICY } from '../../src/shared/policy';

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(() => {
  h?.close();
  h = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'desk-bugbash-'));
  dirs.push(d);
  return d;
};

describe('finding 1: one desk process per database file', () => {
  it('the first process takes the lock, a live holder refuses a second, and a dead holder’s lock is taken over', () => {
    const db = join(tempDir(), 'nested', 'desk.sqlite'); // the folder doesn't exist yet
    const first = acquireLock(db);
    expect(first.ok).toBe(true);
    expect(readFileSync(lockPath(db), 'utf8')).toBe(String(process.pid));

    writeFileSync(lockPath(db), String(process.ppid)); // another live process (the test runner's parent)
    expect(acquireLock(db)).toEqual({ ok: false, heldBy: process.ppid });

    writeFileSync(lockPath(db), '999999999'); // left by a process that no longer exists (kill -9)
    const taken = acquireLock(db);
    expect(taken.ok).toBe(true);
    if (taken.ok) taken.release();
    expect(existsSync(lockPath(db))).toBe(false);
  });

  it('release only removes a lock this process still owns', () => {
    const db = join(tempDir(), 'desk.sqlite');
    const lock = acquireLock(db);
    writeFileSync(lockPath(db), String(process.ppid));
    if (lock.ok) lock.release();
    expect(readFileSync(lockPath(db), 'utf8')).toBe(String(process.ppid));
  });

  it('an in-memory database needs no lock', () => {
    expect(acquireLock(':memory:').ok).toBe(true);
  });
});

describe('finding 2: "Reset demo" is all or nothing', () => {
  it('a reset that dies part-way leaves the old database whole, and the desk boots on it normally', () => {
    h = createHarness({ file: true, world: 'spy' });
    const id = h.create();
    const tasks = h.repo.listTasks().length;
    const sql = h.sql as Sql & { exec: (s: string) => void };
    const exec = sql.exec.bind(sql);
    let drops = 0;
    sql.exec = (s: string) => {
      if (s.startsWith('DROP TABLE') && ++drops === 3) throw new Error('killed mid-reset');
      exec(s);
    };
    expect(() => resetDb(sql)).toThrow('killed mid-reset');
    sql.exec = exec;

    expect(h.repo.listTasks()).toHaveLength(tasks);
    expect(h.task(id).status).toBe('routing');
    h.assertInvariants();
    h = h.restart(T0 + 10 * S);
    expect(h.task(id).status).toBe('routing');
    h.assertInvariants();
  });

  it('a completed reset leaves an empty, current schema', () => {
    h = createHarness({ world: 'spy' });
    h.create();
    resetDb(h.sql);
    expect(seedState(h.sql)).toBe('empty');
    expect(h.repo.listTasks()).toEqual([]);
    expect(h.sql.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`)?.value).toBe('1');
  });
});

describe('finding 3: a first start killed mid-seed is detected, not served', () => {
  it('empty → partial (contributors but no seed marker) → reset → seeded, with every invariant holding', () => {
    const sql = openDb(':memory:');
    expect(seedState(sql)).toBe('empty');
    const repo = createRepo(sql);
    sql.tx(() => {
      repo.insertExpertise('finance', 'Finance', 0);
      repo.insertContributor({ id: 1, name: 'Pat', headline: '', availability: 'available', maxActive: 1, expertise: ['finance'], now: T0 });
    });
    expect(seedState(sql)).toBe('partial');

    resetDb(sql); // what main.ts does for 'partial'
    const app = createApp({ sql, clock: new FakeClock(T0), seed: 'test' });
    seedDemo(app, T0);
    expect(seedState(sql)).toBe('seeded');
    expect(checkInvariants(sql)).toEqual([]);
    sql.close();
  });

  it('a database the desk has already booted on counts as seeded (databases from before the marker)', () => {
    h = createHarness({ world: 'spy' });
    expect(h.sql.get(`SELECT 1 AS x FROM meta WHERE key = 'seeded_at'`)).toBeUndefined();
    expect(seedState(h.sql)).toBe('seeded');
  });

  it('"Reset demo" leaves a database marked as seeded', async () => {
    h = createHarness();
    expect((await h.http.post('/api/sim/reset')).status).toBe(200);
    expect(h.sql.get(`SELECT 1 AS x FROM meta WHERE key = 'seeded_at'`)).toBeDefined();
  });
});

describe('finding 4: changes can only come from the desk’s own pages (cross-site request forgery)', () => {
  const create = { title: 'Forged task', expertiseId: 'finance' };

  it('a plain HTML form on another site cannot reset the demo', async () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    const res = await h.http.post('/api/sim/reset').set('Origin', 'https://evil.example').type('form').send('x=1');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('cross_site_request');
    expect(h.task(id).status).toBe('routing');
  });

  it.each([
    ['a foreign Origin', { Origin: 'https://evil.example' }],
    ['Sec-Fetch-Site: cross-site', { 'Sec-Fetch-Site': 'cross-site' }],
    ['Sec-Fetch-Site: same-site (another app on localhost)', { 'Sec-Fetch-Site': 'same-site' }],
    ['Origin: null (a sandboxed frame or a file:// page)', { Origin: 'null' }],
    ['an Origin that is not a URL', { Origin: 'garbage' }],
  ])('%s → 403, nothing created', async (_name, headers) => {
    h = createHarness({ world: 'spy' });
    const before = h.repo.listTasks().length;
    const res = await h.http.post('/api/tasks').set(headers).send(create);
    expect(res.status).toBe(403);
    expect(h.repo.listTasks()).toHaveLength(before);
  });

  it('the desk’s own page, a browser behind a proxy that rewrites Host, and non-browser clients all get through', async () => {
    h = createHarness({ world: 'spy' });
    expect((await h.http.post('/api/tasks').set({ Host: 'desk.local:3001', Origin: 'http://desk.local:3001' }).send(create)).status).toBe(201);
    expect((await h.http.post('/api/tasks').set({ Origin: 'https://desk.example', 'Sec-Fetch-Site': 'same-origin' }).send(create)).status).toBe(201);
    expect((await h.http.post('/api/tasks').send(create)).status).toBe(201); // curl, scripts, tests
  });

  it('reads are not affected', async () => {
    h = createHarness({ world: 'spy' });
    expect((await h.http.get('/api/snapshot').set('Origin', 'https://evil.example')).status).toBe(200);
  });
});

describe('finding 5: nothing the API returns lets anyone compute a request’s fate (R12)', () => {
  it('health does not include the simulation seed', async () => {
    h = createHarness({ seed: 'a-secret-seed' });
    const res = await h.http.get('/api/health');
    expect(JSON.stringify(res.body)).not.toContain('a-secret-seed');
    expect(res.body).not.toHaveProperty('seed');
  });
});

describe('finding 6: restart catch-up handles what came due in the order it happened', () => {
  const PAIR = {
    expertise: [{ id: 'finance', label: 'Finance' }],
    contributors: [
      { id: 1, name: 'Pat Lee', expertise: ['finance'], maxActive: 2 },
      { id: 2, name: 'Quinn Roy', expertise: ['finance'], maxActive: 2 },
    ],
  } as never;
  const PAT = 1;

  /**
   * Pat holds two offers; the first expires at +30 s. The engine answers "Pat" for task Y at +40 s.
   * In real time the expiry comes first, so Pat has room and the pick is applied.
   */
  function world(downFrom: number | null) {
    h = createHarness({ file: true, world: 'sim', fixture: PAIR, startAt: T0 - 30 * S });
    const x1 = h.create({ submit: false });
    h.cmd(x1, { type: 'offer', contributorId: PAT }); // expires at +30 s
    h.clock.set(T0);
    const y = h.create();
    const attempt = h.task(y).currentAttemptId!;
    h.app.sim!.scriptEngineJob(attempt, T0 + 40 * S, { kind: 'match', contributorId: PAT, reason: 'scripted' });
    h.clock.set(T0 + S);
    const x2 = h.create({ submit: false });
    h.cmd(x2, { type: 'offer', contributorId: PAT }); // Pat is now 2 of 2
    if (downFrom === null) {
      h.advance(49 * S);
    } else {
      h.advance(downFrom - S);
      h = h.restart(T0 + 50 * S); // down from +downFrom to +50 s; boot catches up
    }
    h.assertInvariants();
    return { y, attempt, x1 };
  }

  it('always up: the offer expires at +30 s, then the +40 s pick of Pat is applied', () => {
    const { y, attempt, x1 } = world(null);
    expect(h!.repo.getAttempt(attempt)!.status).toBe('matched');
    expect(h!.task(y).status).toBe('offered');
    expect(h!.task(x1).status).toBe('needs_attention');
  });

  it('down from +25 s to +50 s: catch-up reaches the same outcome, and the history agrees with itself', () => {
    const { y, attempt, x1 } = world(25 * S);
    expect(h!.repo.getAttempt(attempt)!.status).toBe('matched');
    expect(h!.task(y).status).toBe('offered');
    expect(h!.active(y)!.contributorId).toBe(PAT);
    expect(h!.task(x1).status).toBe('needs_attention');
    expect(h!.repo.eventsForTask(y).some((e) => /at capacity/.test(e.summary))).toBe(false);
    const restarted = h!.repo.lastEventOfTypes(['desk_restarted'])!;
    expect(restarted.summary).toMatch(/1 engine answer received, 1 offer expired/);
  });
});

describe('finding 7: user text is validated the same way everywhere, and nothing a client sends causes a 500', () => {
  it.each([
    ['NUL inside the title', { title: 'a\u0000bcdef' }],
    ['a title of NULs', { title: '\u0000\u0000\u0000' }],
    ['a line break in the title', { title: 'Two\nlines' }],
    ['a right-to-left override in the title', { title: 'Invoice ‮exe.pdf' }],
    ['a title of zero-width spaces', { title: '​​​' }],
    ['NUL in the brief', { title: 'Fine title', brief: 'a\u0000b' }],
    ['a line break in “requested by”', { title: 'Fine title', requestedBy: 'Ana\nBen' }],
    ['121 characters of emoji', { title: '😀'.repeat(121) }],
  ])('%s → 400, nothing created', async (_name, body) => {
    h = createHarness({ world: 'spy' });
    const before = h.repo.listTasks().length;
    const res = await h.http.post('/api/tasks').send({ expertiseId: 'finance', ...body });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(h.repo.listTasks()).toHaveLength(before);
  });

  it('120 emoji is a valid title: the schema, the domain and SQLite all count characters', async () => {
    h = createHarness({ world: 'spy' });
    const title = '😀'.repeat(120);
    const res = await h.http.post('/api/tasks').send({ title, expertiseId: 'finance' });
    expect(res.status).toBe(201);
    expect(res.body.task.title).toBe(title);
  });

  it('accented and right-to-left text, and line breaks in briefs and notes, are fine', async () => {
    h = createHarness({ world: 'spy' });
    const res = await h.http.post('/api/tasks').send({ title: 'مراجعة الإيرادات · Café', brief: 'Line one\nLine two\n\t- a bullet', expertiseId: 'finance', submit: false });
    expect(res.status).toBe(201);
    const id = res.body.task.id;
    const cancel = await h.http.post(`/api/tasks/${id}/commands`).send({ type: 'cancel', expectedVersion: res.body.task.version, note: 'Client paused.\nWill revisit in Q3.' });
    expect(cancel.status).toBe(200);
  });

  it('a huge expertise id is refused without echoing it back', async () => {
    h = createHarness({ world: 'spy' });
    const res = await h.http.post('/api/tasks').send({ title: 'Fine title', expertiseId: 'x'.repeat(50_000) });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body).length).toBeLessThan(2_000);
  });

  it('the domain refuses control characters too, so no caller can reach the database CHECK', () => {
    h = createHarness({ world: 'spy' });
    expect(() => h!.app.desk.createTask({ title: 'a\u0000bcdef', expertiseId: 'finance', priority: 'normal' })).toThrow(expect.objectContaining({ code: 'validation_failed', status: 400 }));
  });

  it.each([
    ['GET', '/api/tasks/%E0%A4%A'],
    ['POST', '/api/tasks/%E0%A4%A/commands'],
    ['POST', '/api/sim/assignments/%ZZ/respond'],
  ])('%s %s (malformed %%-escape) → 400, not 500', async (method, path) => {
    h = createHarness({ world: 'spy' });
    const res = method === 'GET' ? await h.http.get(path) : await h.http.post(path).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_url');
  });
});

describe('finding 8: a clock that moved backwards is said out loud', () => {
  it('the restart line says the downtime is unknown and how far back the clock went', () => {
    h = createHarness({ file: true, world: 'spy' });
    h.advance(2 * S);
    h = h.restart(T0 - 3_600 * S);
    const ev = h.repo.lastEventOfTypes(['desk_restarted'])!;
    expect(ev.summary).toMatch(/the system clock is ~.+ earlier than when the desk last ran, so the downtime is unknown/);
    expect(ev.payload).toMatchObject({ offlineMs: 0, clockSkewMs: 3_602 * S });
  });
});

describe('finding 9: a refused "Respond as" click doesn’t cancel the contributor’s own scheduled reply', () => {
  it('“complete” on an open offer is refused; the scripted accept still arrives', async () => {
    h = createHarness();
    const id = h.create({ submit: false, contributor: 'accept' });
    h.cmd(id, { type: 'offer', contributorId: ANA });
    const asg = h.active(id)!.id;
    expect((await h.http.post(`/api/sim/assignments/${asg}/respond`).send({ action: 'complete' })).status).toBe(409);
    h.advance(5 * S);
    expect(h.task(id).status).toBe('assigned');
  });

  it('a click that takes effect still replaces the scripted reply', async () => {
    h = createHarness();
    const id = h.create({ submit: false, contributor: 'accept' });
    h.cmd(id, { type: 'offer', contributorId: ANA });
    const asg = h.active(id)!.id;
    expect((await h.http.post(`/api/sim/assignments/${asg}/respond`).send({ action: 'decline', note: 'Busy' })).status).toBe(200);
    h.advance(5 * S);
    expect(h.task(id).status).toBe('needs_attention');
    expect(h.types(id).filter((t) => t === 'late_response_ignored')).toEqual([]);
  });
});

describe('finding 10: repeating a refused reply doesn’t grow the history', () => {
  it('200 identical refusals are recorded once; a different refusal is recorded once more', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ submit: false });
    h.cmd(id, { type: 'offer', contributorId: ANA });
    const ignored = () => h!.types(id).filter((t) => t === 'late_response_ignored').length;
    for (let i = 0; i < 200; i++) expect(h.respond(id, 'complete').ok).toBe(false);
    expect(ignored()).toBe(1);
    for (let i = 0; i < 50; i++) {
      h.respond(id, 'start');
      h.respond(id, 'complete');
    }
    expect(ignored()).toBe(2);
  });

  it('after the offer ends, a late reply is still recorded (once)', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ submit: false });
    h.cmd(id, { type: 'offer', contributorId: ANA });
    h.cmd(id, { type: 'revoke_offer' });
    for (let i = 0; i < 20; i++) h.respond(id, 'accept');
    expect(h.types(id).filter((t) => t === 'late_response_ignored')).toHaveLength(1);
  });
});

describe('finding 12: health is honest when deadlines aren’t being enforced', () => {
  it('503 when the last tick is more than a few ticks old; 200 again once ticking resumes', async () => {
    h = createHarness({ world: 'spy' });
    h.clock.advance(5 * POLICY.tickMs); // time passes, nothing ticks (e.g. the database is locked by another process)
    const stale = await h.http.get('/api/health');
    expect(stale.status).toBe(503);
    expect(stale.body.ok).toBe(false);
    h.app.tick();
    expect((await h.http.get('/api/health')).status).toBe(200);
  });
});

describe('production static serving', () => {
  function staticApp() {
    const dir = tempDir();
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Desk</title>');
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
    const app = createApp({ sql: openDb(':memory:'), clock: new FakeClock(T0), seed: 'test', staticDir: dir });
    return request(app.http);
  }

  it('the app shell is revalidated on every load; fingerprinted assets are cached for a year', async () => {
    const http = staticApp();
    const shell = await http.get('/');
    expect(shell.status).toBe(200);
    expect(shell.headers['cache-control']).toBe('no-cache');
    expect(shell.headers['content-security-policy']).toContain("default-src 'self'");
    const deep = await http.get('/activity');
    expect(deep.text).toContain('<title>Desk</title>');
    const asset = await http.get('/assets/index-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('a missing asset is a 404, not the app shell (a tab on an old build must not get HTML for its script)', async () => {
    const res = await staticApp().get('/assets/index-old999.js');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<title>');
  });

  it('a malformed %-escape in a page URL is a 400, not a 500', async () => {
    expect((await staticApp().get('/x/%E0%A4%A')).status).toBe(400);
  });

  it('JSON responses carry no ETag (they are no-store; hashing a large snapshot is wasted work)', async () => {
    const res = await staticApp().get('/api/snapshot');
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeUndefined();
  });
});
