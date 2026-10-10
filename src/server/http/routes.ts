import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { ZodError } from 'zod';
import { ActivityQuery, AvailabilityBody, CommandBody, CreateTaskBody, DeliverBody, RespondBody } from '../../shared/schemas';
import { DomainError, InvariantError, notFound } from '../domain/errors';
import { resetDb } from '../infra/db';
import { fnv1a32 } from '../infra/rng';
import type { AppCore } from '../app';
import { seedDemo } from '../seed/seed';

function parseId(raw: string | string[] | undefined, what: string): number {
  const n = typeof raw === 'string' && /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n <= 0) throw notFound(what, String(raw));
  return n;
}

export function createHttp(app: AppCore, opts: { staticDir?: string } = {}) {
  const { desk, views, clock, log } = app;
  const repo = desk.repo;
  const http = express();
  http.disable('x-powered-by');
  http.set('etag', false); // API answers are no-store; hashing a large snapshot for a tag nobody can reuse is waste
  // Baseline hardening without a dependency: no MIME sniffing, no framing, no referrer leaks; API answers are never cached.
  http.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    else if (opts.staticDir) {
      // The built UI only ever loads its own files. Inline styles are allowed because React sets style attributes.
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
    }
    next();
  });
  // Cross-site request forgery: a page on another site can make the browser POST here (a plain form needs
  // no preflight), so writes must come from this desk's own pages. Non-browser clients send neither header.
  http.use('/api', (req, _res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const site = req.get('sec-fetch-site');
    if (site === 'same-origin' || site === 'none') return next();
    const origin = req.get('origin');
    let originHost: string | null = null;
    try {
      originHost = origin && origin !== 'null' ? new URL(origin).host : null;
    } catch {
      // unparsable: treated as foreign below
    }
    if (site === 'cross-site' || site === 'same-site' || (origin !== undefined && originHost !== req.get('host'))) {
      return next(new DomainError('cross_site_request', 403, 'Changes can only be made from the desk itself.'));
    }
    next();
  });
  http.use(express.json({ limit: '100kb' }));

  const detailOr404 = (id: number) => {
    const d = views.taskDetail(id);
    if (!d) throw notFound('Task', id);
    return d;
  };

  // Never includes the simulation seed: with it (and the open-source RNG) anyone could compute every request's fate (R12).
  // Not ok when deadlines haven't been enforced for a few ticks (e.g. the database is locked by another process).
  http.get('/api/health', (_req, res) => {
    const now = clock.now();
    const lastTickAt = Number(repo.getMeta('last_tick_at') ?? 0);
    const ok = now - lastTickAt <= 4 * app.policy.tickMs;
    res.status(ok ? 200 : 503).json({ ok, serverNow: now, bootId: app.bootInfo.bootId, lastTickAt });
  });

  // Reads never mutate (no tick here): the 500 ms ticker and the pre-command tick keep state current.
  http.get('/api/snapshot', (_req, res) => {
    res.json(views.snapshot(clock.now(), app.bootInfo));
  });

  // Desk-wide history, newest first. Page backwards with ?before=<event id>.
  http.get('/api/activity', (req, res) => {
    const q = ActivityQuery.parse(req.query);
    res.json(views.activity(q.limit, q.before));
  });

  http.get('/api/tasks/:id', (req, res) => {
    res.json(detailOr404(parseId(req.params.id, 'Task')));
  });

  http.post('/api/tasks', (req, res) => {
    const body = CreateTaskBody.parse(req.body);
    const now = clock.now();
    app.tick(now);
    const task = desk.createTask(
      { title: body.title, brief: body.brief, requestedBy: body.requestedBy, expertiseId: body.expertiseId, priority: body.priority },
      { submit: body.submit, onCreated: app.sim ? (id) => app.sim!.setScenario(id, body.sim?.engine ?? 'realistic', body.sim?.contributor ?? 'manual') : undefined },
      now,
    );
    res.status(201).json({ task: detailOr404(task.id) });
  });

  http.post('/api/tasks/:id/commands', (req, res) => {
    const id = parseId(req.params.id, 'Task');
    const cmd = CommandBody.parse(req.body);
    const now = clock.now();
    app.tick(now); // drain the inbox first, so the decision is made against the current world
    try {
      desk.command(id, cmd, now);
    } catch (err) {
      if (err instanceof DomainError && err.status === 409) {
        // Tell the operator what moved since they looked, and hand back the current task.
        const unseen = cmd.seenEventId !== undefined ? repo.eventsForTaskAfter(id, cmd.seenEventId).map(views.eventDto) : [];
        res.status(409).json({ error: { code: err.code, message: err.message, ...err.details, unseen, task: views.taskDetail(id) } });
        return;
      }
      throw err;
    }
    res.json({ task: detailOr404(id) });
  });

  // ── Simulation endpoints: the outside world. Not operator actions. ──

  http.post('/api/sim/assignments/:id/respond', (req, res) => {
    const id = parseId(req.params.id, 'Assignment');
    const body = RespondBody.parse(req.body);
    const asg = repo.getAssignment(id);
    if (!asg) throw notFound('Assignment', id);
    const now = clock.now();
    app.tick(now);
    const r = app.sim ? app.sim.respondAs(id, body.action, body.note ?? null, now) : desk.respond(id, body.action, { note: body.note, simulatedBy: 'button' }, now);
    if (!r.ok) {
      res.status(409).json({ error: { code: r.code, message: r.message, task: views.taskDetail(asg.taskId) } });
      return;
    }
    res.json({ task: detailOr404(asg.taskId) });
  });

  http.post('/api/sim/attempts/:id/deliver', (req, res) => {
    const id = parseId(req.params.id, 'Request');
    const body = DeliverBody.parse(req.body);
    const attempt = repo.getAttempt(id);
    if (!attempt) throw notFound('Request', id);
    if (body.outcome === 'match' && !repo.getContributor(body.contributorId!)) throw notFound('Contributor', body.contributorId!);
    if (!app.sim) throw new DomainError('sim_disabled', 409, 'The simulator is not running.');
    const now = clock.now();
    app.tick(now);
    const result = body.outcome === 'match' ? ({ kind: 'match', contributorId: body.contributorId! } as const) : ({ kind: 'no_match' } as const);
    const r = app.sim.deliverNow(id, result, now);
    res.json({ applied: r.applied, reason: r.reason, task: detailOr404(attempt.taskId) });
  });

  http.patch('/api/sim/contributors/:id', (req, res) => {
    const id = parseId(req.params.id, 'Contributor');
    const body = AvailabilityBody.parse(req.body);
    desk.setAvailability(id, body.availability);
    res.json({ ok: true });
  });

  http.post('/api/sim/reset', (_req, res) => {
    const now = clock.now();
    resetDb(app.sql);
    seedDemo(app, now);
    desk.emitSystem('desk_reset', 'Demo data reset: all tasks and history were replaced with the seed.', {}, now);
    app.boot(now);
    app.onReset?.();
    res.json({ ok: true });
  });

  http.use('/api', (_req, _res, next) => next(new DomainError('not_found', 404, 'No such endpoint')));

  if (opts.staticDir && existsSync(opts.staticDir)) {
    // Vite fingerprints everything under /assets, so those files never change: cache them for a year.
    // index.html is revalidated on every load, so a new deploy is picked up immediately.
    http.use(
      express.static(opts.staticDir, {
        index: false,
        setHeaders: (res, path) => res.setHeader('Cache-Control', path.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'),
      }),
    );
    // A missing asset is a 404, not the app shell: a tab still running an old build must not get HTML for its script.
    http.use('/assets', (_req, _res, next) => next(new DomainError('not_found', 404, 'No such file')));
    http.get('/{*splat}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(opts.staticDir!, 'index.html'));
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  http.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: { code: 'validation_failed', message: err.issues[0]?.message ?? 'Invalid request', issues: err.issues } });
      return;
    }
    if (err instanceof DomainError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.details } });
      return;
    }
    if ((err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'validation_failed', message: 'Request body is not valid JSON' } });
      return;
    }
    // Other refusals from Express itself carry their own 4xx status: body too large, unsupported charset or
    // encoding, or a URL whose %-escapes don't decode (that one isn't marked `expose`, so use our own words).
    const e = err as { status?: number; statusCode?: number; expose?: boolean; type?: string; message?: string };
    const status = e.status ?? e.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const code = e.type?.replaceAll('.', '_') ?? (err instanceof URIError ? 'bad_url' : 'bad_request');
      res.status(status).json({ error: { code, message: e.expose && e.message ? e.message : 'The request could not be read.' } });
      return;
    }
    const errorId = fnv1a32(`${clock.now()}|${req.path}|${String(err)}`)
      .toString(16)
      .slice(0, 6);
    log.error('http.unhandled', { errorId, path: req.path, error: (err as Error)?.stack ?? String(err), invariant: err instanceof InvariantError });
    res
      .status(500)
      .json({ error: { code: err instanceof InvariantError ? 'invariant_violation' : 'internal', message: `Something went wrong (ref ${errorId}). Refresh to see the current state.`, errorId } });
  });

  return http;
}
