// SIMULATION ONLY: the outside world. Implements the desk's engine and contributor ports by
// writing rows into `sim_jobs` (a durable inbox that survives restarts, like an external service
// would), and delivers due jobs back through the desk's public commands — the same path a real
// webhook would take. This is the only module that touches `sim_*` tables.
import type { Sql } from '../infra/db';
import type { Logger } from '../infra/log';
import type { ContributorChannel, DispatchRequest, EngineResult, OfferNotice, RoutingEngine } from '../engine/port';
import type { Desk, ApplyResult, RespondResult } from '../commands/desk';
import type { ContributorAction } from '../../shared/policy';
import { CONTRIBUTOR_PRESETS, ENGINE_PRESETS, type ContributorPreset, type EnginePreset } from '../../shared/sim-presets';
import { planFate } from './fate';

interface JobRow {
  id: number;
  kind: 'engine_result' | 'contributor_response';
  refId: number;
  dueAt: number;
  payloadJson: string;
}

const CONTRIBUTOR_SCRIPTS: Record<ContributorPreset, { action: ContributorAction; afterMs: number; note?: string }[]> = {
  manual: [],
  ignore: [],
  accept: [{ action: 'accept', afterMs: 4_000 }],
  decline: [{ action: 'decline', afterMs: 4_000, note: 'Conflict: I advise a competitor of this client.' }],
  withdraw_after_accept: [
    { action: 'accept', afterMs: 4_000 },
    { action: 'withdraw', afterMs: 10_000, note: 'Travelling for two weeks; I can no longer take this on.' },
  ],
};

export function createSimulator(deps: { sql: Sql; seed: string; log: Logger }) {
  const { sql, seed, log } = deps;
  let desk: Desk | null = null;

  const scenario = (taskId: number) =>
    sql.get<{ engine: EnginePreset; contributor: ContributorPreset; used: number }>(`SELECT engine, contributor, contributor_used AS used FROM sim_task_scenarios WHERE task_id = ?`, taskId);

  function insertJob(kind: JobRow['kind'], refId: number, dueAt: number | null, payload: unknown, now: number) {
    sql.run(`INSERT INTO sim_jobs (kind, ref_id, due_at, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`, kind, refId, dueAt, JSON.stringify(payload), now);
  }

  function cancelJobs(kind: JobRow['kind'], refId: number, now: number): number {
    return sql.run(`UPDATE sim_jobs SET cancelled_at = ? WHERE kind = ? AND ref_id = ? AND delivered_at IS NULL AND cancelled_at IS NULL`, now, kind, refId).changes;
  }

  const engine: RoutingEngine = {
    dispatch(req: DispatchRequest) {
      const preset = (scenario(req.taskId)?.engine ?? 'realistic') as EnginePreset;
      const fate = planFate(seed, req, preset);
      insertJob('engine_result', req.attemptId, fate.dueInMs === null ? null : req.dispatchedAt + fate.dueInMs, fate.result, req.dispatchedAt);
      // The fate is the answer key; keep it out of normal logs.
      log.debug('sim.fate', { task: req.taskId, seq: req.seq, preset, dueInMs: fate.dueInMs, result: fate.result.kind });
    },
  };

  const channel: ContributorChannel = {
    offerCreated(o: OfferNotice) {
      const s = scenario(o.taskId);
      if (!s || s.used) return; // presets apply to the first offer only; later offers wait for "Respond as"
      sql.run(`UPDATE sim_task_scenarios SET contributor_used = 1 WHERE task_id = ?`, o.taskId);
      for (const step of CONTRIBUTOR_SCRIPTS[s.contributor] ?? []) {
        insertJob('contributor_response', o.assignmentId, o.offeredAt + step.afterMs, { action: step.action, note: step.note ?? null }, o.offeredAt);
      }
    },
  };

  /**
   * Deliver everything that is due, oldest first. Each delivery commits together with its "delivered" mark.
   * `before(dueAt)` runs ahead of each delivery, so the desk can first enforce deadlines that passed earlier.
   */
  function pump(now: number, before?: (dueAt: number) => void): { engine: number; contributor: number } {
    if (!desk) throw new Error('simulator not attached to a desk');
    const d = desk;
    const jobs = sql.all<JobRow>(
      `SELECT id, kind, ref_id AS refId, due_at AS dueAt, payload_json AS payloadJson FROM sim_jobs
       WHERE delivered_at IS NULL AND cancelled_at IS NULL AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at, id`,
      now,
    );
    const counts = { engine: 0, contributor: 0 };
    for (const job of jobs) {
      before?.(job.dueAt);
      try {
        d.transaction(() => {
          const marked = sql.run(`UPDATE sim_jobs SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL AND cancelled_at IS NULL`, now, job.id).changes;
          if (!marked) return;
          const payload = JSON.parse(job.payloadJson);
          if (job.kind === 'engine_result') {
            d.inner.applyEngineResult(job.refId, payload as EngineResult, job.dueAt, now);
            counts.engine++;
          } else {
            d.inner.respond(job.refId, payload.action, { note: payload.note, simulatedBy: 'preset' }, now);
            counts.contributor++;
          }
        });
      } catch (err) {
        // Left undelivered; retried on the next tick. Domain refusals don't throw, so this is a bug.
        log.error('sim.pump.failed', { job: job.id, kind: job.kind, error: (err as Error).message });
      }
    }
    return counts;
  }

  return {
    engine,
    channel,
    attach(d: Desk) {
      desk = d;
    },
    pump,

    setScenario(taskId: number, engineP: string, contributorP: string) {
      if (!ENGINE_PRESETS.some((p) => p.id === engineP)) throw new Error(`unknown engine preset ${engineP}`);
      if (!CONTRIBUTOR_PRESETS.some((p) => p.id === contributorP)) throw new Error(`unknown contributor preset ${contributorP}`);
      sql.run(
        `INSERT INTO sim_task_scenarios (task_id, engine, contributor) VALUES (?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET engine = excluded.engine, contributor = excluded.contributor, contributor_used = 0`,
        taskId,
        engineP,
        contributorP,
      );
    },

    /** "The engine answers this request right now" (simulation control). Any scheduled answer is cancelled. */
    deliverNow(attemptId: number, result: EngineResult, now: number): ApplyResult {
      const d = desk!;
      return d.transaction(() => {
        cancelJobs('engine_result', attemptId, now);
        return d.inner.applyEngineResult(attemptId, { ...result, reason: result.reason ?? null, simulatedBy: 'button' }, now, now);
      });
    },

    /**
     * "Respond as <contributor>" (simulation control). If it takes effect (or the offer has ended), any
     * scheduled response for this offer is cancelled. A click that doesn't fit the offer's state changes
     * nothing, so the contributor's scheduled reply still comes.
     */
    respondAs(assignmentId: number, action: ContributorAction, note: string | null, now: number): RespondResult {
      const d = desk!;
      return d.transaction(() => {
        const r = d.inner.respond(assignmentId, action, { note, simulatedBy: 'button' }, now);
        if (r.ok || r.code !== 'invalid_action') cancelJobs('contributor_response', assignmentId, now);
        return r;
      });
    },

    /** For tests and the restart test: how many deliveries are still outstanding. */
    pendingJobCount(): number {
      return sql.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sim_jobs WHERE delivered_at IS NULL AND cancelled_at IS NULL`)!.n;
    },

    /** Test-only: override when a planned engine answer arrives (exact timings for deadline tests). */
    scriptEngineJob(attemptId: number, dueAt: number | null, result?: EngineResult) {
      const job = sql.get<{ id: number; payloadJson: string }>(`SELECT id, payload_json AS payloadJson FROM sim_jobs WHERE kind = 'engine_result' AND ref_id = ? AND delivered_at IS NULL`, attemptId);
      if (!job) throw new Error(`no undelivered engine job for attempt ${attemptId}`);
      sql.run(`UPDATE sim_jobs SET due_at = ?, payload_json = ? WHERE id = ?`, dueAt, JSON.stringify(result ?? JSON.parse(job.payloadJson)), job.id);
    },
  };
}

export type Simulator = ReturnType<typeof createSimulator>;
