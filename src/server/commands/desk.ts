// The desk: every state change goes through a function in this file, each in exactly one
// transaction, each guarded by compare-and-set, each writing its history in the same transaction.
import type { Sql } from '../infra/db';
import type { Clock } from '../infra/clock';
import type { Logger } from '../infra/log';
import { POLICY, allowedCommands, isFinal, type ContributorAction, type Policy, type Priority } from '../../shared/policy';
import type { ParsedCommand } from '../../shared/schemas';
import { charCount, plural, secs, unsafeText } from '../../shared/format';
import { createRepo, type AssignmentRec, type AttemptRec, type TaskRec } from '../store/repo';
import type { ContributorChannel, EngineResult, RoutingEngine } from '../engine/port';
import { DomainError, InvariantError, notFound } from '../domain/errors';
import { judge, EXCLUSION_CLAUSE, EXCLUSION_TEXT } from '../domain/eligibility';
import { makeCtx, must, withNote, type Ctx } from './context';
import { abandonPending, createOffer, dispatch, explainLate, retryOrEscalate, toAttention } from './routing';

export interface DeskDeps {
  sql: Sql;
  clock: Clock;
  engine: RoutingEngine;
  channel: ContributorChannel;
  log: Logger;
  policy?: Policy;
}

export type ApplyResult = { applied: boolean; reason: 'applied' | 'late' | 'duplicate' | 'unknown_attempt' | 'invalid_result' | 'no_match' };
export type RespondResult = { ok: true } | { ok: false; code: string; message: string };

export function createDesk(deps: DeskDeps) {
  const { sql, clock, log } = deps;
  const policy = deps.policy ?? POLICY;
  const repo = createRepo(sql);
  let catchUp = false;
  const ctxDeps = { repo, policy, engine: deps.engine, channel: deps.channel, inTx: () => sql.inTransaction };
  const ctxAt = (now: number): Ctx => makeCtx(ctxDeps, now, catchUp);
  const tx = <T>(fn: () => T): T => sql.tx(fn);

  // ── Engine answers ────────────────────────────────────────────────────────

  /**
   * The fencing core. An answer is applied only if its request is still pending, is the request
   * the task is waiting on, and the task is still routing. Anything else is written down once and
   * shown in the history, never applied. The deadline is judged by when the answer reached our
   * inbox (`availableAt`), not by when we happened to process it.
   */
  function applyEngineResultInner(ctx: Ctx, attemptId: number, r: EngineResult, availableAt: number): ApplyResult {
    const a = repo.getAttempt(attemptId);
    if (!a) {
      ctx.emit({
        type: 'engine_result_unknown_attempt',
        actor: 'engine',
        taskId: null,
        summary: `Engine answered request id ${attemptId}, which this desk doesn't know (it may predate a reset). Ignored.`,
        payload: { attemptId },
      });
      return { applied: false, reason: 'unknown_attempt' };
    }
    const contributorId = r.kind === 'match' ? r.contributorId : null;
    if (repo.recordResultOnce(a.id, { kind: r.kind, contributorId, reason: r.reason ?? null }, availableAt) === 0) {
      log.warn('engine.result.duplicate', { attemptId });
      return { applied: false, reason: 'duplicate' };
    }
    if (a.status === 'pending' && availableAt >= a.deadlineAt) {
      // The answer arrived after we would have stopped waiting; the deadline wins regardless of tick timing.
      timeoutAttemptInner(ctx, a);
    }
    const cur = repo.getAttempt(a.id)!;
    const task = repo.getTask(a.taskId)!;
    const latency = availableAt - a.dispatchedAt;
    const pick = contributorId !== null ? repo.contributorName(contributorId) : 'no match';
    const simTag = r.simulatedBy ? { simulatedBy: r.simulatedBy } : {};

    if (cur.status !== 'pending' || task.currentAttemptId !== a.id || task.status !== 'routing') {
      ctx.emit({
        type: 'late_result_ignored',
        actor: 'engine',
        taskId: task.id,
        attemptId: a.id,
        contributorId,
        summary: `Late answer to request #${a.seq} after ${secs(latency)}: ${pick}. Not applied: ${explainLate(ctx, cur, task)}.`,
        payload: { seq: a.seq, kind: r.kind, contributorId, latencyMs: latency, attemptStatus: cur.status, ...simTag },
      });
      log.info('engine.result', { task: task.id, seq: a.seq, outcome: 'ignored_late' });
      return { applied: false, reason: 'late' };
    }

    if (r.kind === 'no_match') {
      must(repo.closeAttempt(a.id, 'no_match', availableAt), 'close no_match');
      toAttention(ctx, task, 'no_match');
      ctx.emit({
        type: 'attempt_no_match',
        actor: 'engine',
        taskId: task.id,
        attemptId: a.id,
        summary: `Request #${a.seq} answered after ${secs(latency)}: no match among ${plural(a.candidates.length, 'candidate')}.${r.reason ? ` ${r.reason}` : ''} We don't retry a definite no-match; the task needs your decision.`,
        payload: { seq: a.seq, latencyMs: latency, ...simTag },
      });
      log.info('engine.result', { task: task.id, seq: a.seq, outcome: 'no_match' });
      return { applied: true, reason: 'no_match' };
    }

    // Re-check the pick now: things may have changed in the 5–20 s since dispatch.
    const why = recheckPick(task, a, r.contributorId);
    if (why) {
      must(repo.closeAttempt(a.id, 'invalid_result', availableAt, { invalidReason: why.code }), 'close invalid_result');
      ctx.emit({
        type: 'attempt_invalid_result',
        actor: 'engine',
        taskId: task.id,
        attemptId: a.id,
        contributorId: r.contributorId,
        summary: `Request #${a.seq} answered after ${secs(latency)}: ${pick}, but ${why.text}. Not applied.`,
        payload: { seq: a.seq, latencyMs: latency, invalidReason: why.code, contributorId: r.contributorId, ...simTag },
      });
      retryOrEscalate(ctx, task.id);
      log.info('engine.result', { task: task.id, seq: a.seq, outcome: 'invalid', why: why.code });
      return { applied: false, reason: 'invalid_result' };
    }

    must(repo.closeAttempt(a.id, 'matched', availableAt), 'close matched');
    ctx.emit({
      type: 'attempt_matched',
      actor: 'engine',
      taskId: task.id,
      attemptId: a.id,
      contributorId: r.contributorId,
      summary: `Request #${a.seq} answered after ${secs(latency)}: ${pick}.${r.reason ? ` ${r.reason}` : ''}`,
      payload: { seq: a.seq, latencyMs: latency, contributorId: r.contributorId, ...simTag },
    });
    const assignmentId = createOffer(ctx, repo.getTask(task.id)!, { contributorId: r.contributorId, source: 'engine', attemptId: a.id });
    ctx.emit({
      type: 'offer_created',
      actor: 'system',
      taskId: task.id,
      assignmentId,
      contributorId: r.contributorId,
      summary: `Offered to ${pick} (engine pick, request #${a.seq}). ${pick} has ${secs(policy.offerTtlMs).replace('.0s', 's')} to reply.`,
      payload: { source: 'engine', seq: a.seq, expiresAt: ctx.now + policy.offerTtlMs },
    });
    log.info('engine.result', { task: task.id, seq: a.seq, outcome: 'applied', contributor: r.contributorId });
    return { applied: true, reason: 'applied' };
  }

  function recheckPick(task: TaskRec, a: AttemptRec, contributorId: number): { code: string; text: string } | null {
    const name = repo.contributorName(contributorId);
    if (!a.candidates.some((c) => c.contributorId === contributorId)) {
      return { code: 'not_in_snapshot', text: `${name} was not one of the candidates sent with this request` };
    }
    const facts = repo.contributorFacts().find((c) => c.id === contributorId);
    if (!facts) return { code: 'unknown_contributor', text: `${name} no longer exists` };
    const v = judge(facts, task.expertiseId, repo.exclusions(task.id));
    switch (v.blocker) {
      case null:
        return null;
      case 'away':
        return { code: 'away', text: `${name} is now away` };
      case 'at_capacity':
        return { code: 'at_capacity', text: `${name} is now at capacity (${facts.load}/${facts.maxActive})` };
      case 'excluded':
        return { code: 'excluded', text: `${name} is excluded for this task` };
      case 'no_expertise':
        return { code: 'no_expertise', text: `${name} no longer has this expertise` };
    }
  }

  // ── Deadlines ─────────────────────────────────────────────────────────────

  function timeoutAttemptInner(ctx: Ctx, a: AttemptRec): void {
    must(repo.closeAttempt(a.id, 'timed_out', a.deadlineAt), `timeout attempt ${a.id}`);
    const waited = secs(a.deadlineAt - a.dispatchedAt).replace('.0s', 's');
    ctx.emit({
      type: 'attempt_timed_out',
      actor: 'system',
      taskId: a.taskId,
      attemptId: a.id,
      summary: `No answer to request #${a.seq} after ${waited}. Stopped waiting: it may be slow, or it may never answer, and we can't tell which. If it answers later, the answer is recorded, not applied.`,
      payload: { seq: a.seq, deadlineAt: a.deadlineAt },
    });
    retryOrEscalate(ctx, a.taskId);
  }

  function expireOfferInner(ctx: Ctx, asg: AssignmentRec): void {
    must(repo.moveAssignment(asg.id, ['offered'], 'expired', { endedAt: asg.expiresAt }), `expire offer ${asg.id}`);
    const task = repo.getTask(asg.taskId)!;
    toAttention(ctx, task, 'offer_expired');
    const name = repo.contributorName(asg.contributorId);
    ctx.emit({
      type: 'offer_expired',
      actor: 'system',
      taskId: task.id,
      assignmentId: asg.id,
      contributorId: asg.contributorId,
      summary: `${name} didn't reply within ${secs(asg.expiresAt - asg.offeredAt).replace('.0s', 's')}. The offer expired; ${name} is excluded from engine routing for this task. We don't re-route automatically after a person doesn't reply.`,
      payload: { expiresAt: asg.expiresAt },
    });
  }

  /**
   * Enforce every deadline at or before `upTo` (default: now). Idempotent; each item in its own transaction.
   * The tick passes an earlier `upTo` to enforce what came due before an answer that is about to be delivered.
   */
  function enforceDeadlines(now: number, upTo = now): { timedOut: number; expired: number } {
    let timedOut = 0;
    let expired = 0;
    for (const id of repo.duePendingAttemptIds(upTo)) {
      tx(() => {
        const a = repo.getAttempt(id);
        if (a && a.status === 'pending' && a.deadlineAt <= upTo) {
          timeoutAttemptInner(ctxAt(now), a);
          timedOut++;
        }
      });
    }
    for (const id of repo.dueOfferIds(upTo)) {
      tx(() => {
        const asg = repo.getAssignment(id);
        if (asg && asg.status === 'offered' && asg.expiresAt <= upTo) {
          expireOfferInner(ctxAt(now), asg);
          expired++;
        }
      });
    }
    return { timedOut, expired };
  }

  // ── Contributor responses ─────────────────────────────────────────────────

  function respondInner(ctx: Ctx, assignmentId: number, action: ContributorAction, opts: { note?: string | null; simulatedBy?: string }): RespondResult {
    const asg = repo.getAssignment(assignmentId);
    if (!asg) throw notFound('Assignment', assignmentId);
    const task = repo.getTask(asg.taskId)!;
    const name = repo.contributorName(asg.contributorId);
    const note = opts.note?.trim() || null;
    const base = { taskId: task.id, assignmentId: asg.id, contributorId: asg.contributorId };
    const sim = opts.simulatedBy ? { simulatedBy: opts.simulatedBy } : {};
    const verb: Record<ContributorAction, string> = { accept: 'accept', decline: 'decline', start: 'start work', withdraw: 'withdraw', complete: 'complete the work' };

    // A refused reply changes nothing, so it is recorded once per action and assignment state, not once per
    // repeat: a retrying client or a stuck button must not be able to grow the history without bound.
    const repeat = () => repo.refusalRecorded(task.id, asg.id, action, asg.status);
    const ignore = (why: string): RespondResult => {
      if (!repeat())
        ctx.emit({
          ...base,
          type: 'late_response_ignored',
          actor: 'contributor',
          summary: `${name} tried to ${verb[action]}, but ${why}. Not applied.`,
          payload: { action, assignmentStatus: asg.status, ...sim },
        });
      return { ok: false, code: 'assignment_not_active', message: `${name} tried to ${verb[action]}, but ${why}.` };
    };
    const ENDED_WHY: Partial<Record<AssignmentRec['status'], string>> = {
      revoked: 'the offer had been revoked',
      expired: 'the offer had expired',
      cancelled: 'the task had been cancelled',
      declined: 'they had already declined',
      withdrawn: 'they had already withdrawn',
      released: 'they had been released from the task',
      completed: 'the work was already completed',
    };
    if (ENDED_WHY[asg.status]) return ignore(ENDED_WHY[asg.status]!);
    // An action that doesn't fit the assignment's status (e.g. "start" before accepting) changes nothing,
    // but it is recorded once, so the history explains what the contributor tried (PLAN TT-22).
    const refuse = (message: string): RespondResult => {
      if (!repeat())
        ctx.emit({
          ...base,
          type: 'late_response_ignored',
          actor: 'contributor',
          summary: `${name} tried to ${verb[action]}, but ${message.charAt(0).toLowerCase()}${message.slice(1).replace(/\.$/, '')}. Not applied.`,
          payload: { action, assignmentStatus: asg.status, ...sim },
        });
      return { ok: false, code: 'invalid_action', message };
    };

    switch (action) {
      case 'accept':
      case 'decline': {
        if (asg.status !== 'offered') return refuse(asg.status === 'accepted' ? 'They had already accepted.' : 'Work had already started.');
        if (ctx.now >= asg.expiresAt) {
          expireOfferInner(ctx, asg);
          return ignore('the offer had expired');
        }
        if (action === 'accept') {
          must(repo.moveAssignment(asg.id, ['offered'], 'accepted', { respondedAt: ctx.now }), 'accept');
          must(repo.casTask(task.id, { status: 'offered' }, { status: 'assigned', statusChangedAt: ctx.now, bumpVersion: true }), 'task assigned');
          ctx.emit({ ...base, type: 'offer_accepted', actor: 'contributor', summary: `${name} accepted. Routing complete.`, payload: { ...sim } });
        } else {
          must(repo.moveAssignment(asg.id, ['offered'], 'declined', { respondedAt: ctx.now, endedAt: ctx.now, note }), 'decline');
          toAttention(ctx, task, 'declined');
          ctx.emit({
            ...base,
            type: 'offer_declined',
            actor: 'contributor',
            summary: `${name} declined${note ? `: “${note}”.` : '.'} ${name} is excluded from engine routing for this task. We don't re-route automatically after a person says no.`,
            payload: { note, ...sim },
          });
        }
        return { ok: true };
      }
      case 'start': {
        if (asg.status !== 'accepted') return refuse(asg.status === 'offered' ? 'They hadn’t accepted the offer yet.' : 'Work had already started.');
        must(repo.moveAssignment(asg.id, ['accepted'], 'in_progress', { startedAt: ctx.now }), 'start');
        must(repo.casTask(task.id, { status: 'assigned' }, { status: 'in_progress', statusChangedAt: ctx.now, bumpVersion: true }), 'task in_progress');
        ctx.emit({ ...base, type: 'work_started', actor: 'contributor', summary: `${name} started work.`, payload: { ...sim } });
        return { ok: true };
      }
      case 'withdraw': {
        if (asg.status !== 'accepted') return refuse(asg.status === 'offered' ? 'They hadn’t accepted; declining is how to say no to an offer.' : 'Work had already started.');
        must(repo.moveAssignment(asg.id, ['accepted'], 'withdrawn', { endedAt: ctx.now, note }), 'withdraw');
        toAttention(ctx, task, 'failed_before_start');
        ctx.emit({
          ...base,
          type: 'assignment_withdrawn',
          actor: 'contributor',
          summary: `${name} withdrew before starting${note ? `: “${note}”.` : '.'} Routing had completed; reopening it is your call. ${name} is excluded from engine routing for this task.`,
          payload: { note, ...sim },
        });
        return { ok: true };
      }
      case 'complete': {
        if (asg.status !== 'in_progress') return refuse('Work hadn’t started yet.');
        must(repo.moveAssignment(asg.id, ['in_progress'], 'completed', { endedAt: ctx.now }), 'complete');
        must(repo.casTask(task.id, { status: 'in_progress' }, { status: 'completed', closedAt: ctx.now, statusChangedAt: ctx.now, bumpVersion: true }), 'task completed');
        ctx.emit({ ...base, type: 'work_completed', actor: 'contributor', summary: `${name} completed the work.`, payload: { ...sim } });
        return { ok: true };
      }
    }
  }

  // ── Operator commands ─────────────────────────────────────────────────────

  function operatorCommand(taskId: number, cmd: ParsedCommand, now: number): TaskRec {
    return tx(() => operatorCommandInner(ctxAt(now), taskId, cmd));
  }

  function operatorCommandInner(ctx: Ctx, taskId: number, cmd: ParsedCommand): TaskRec {
    const now = ctx.now;
    const task = repo.getTask(taskId);
    if (!task) throw notFound('Task', taskId);
    if (cmd.expectedVersion !== task.version) {
      throw new DomainError('version_conflict', 409, 'This task changed while you were looking.', { currentVersion: task.version });
    }
    if (isFinal(task.status)) {
      throw new DomainError('invalid_transition', 409, `T-${task.id} is ${task.status}; nothing more can be done to it.`, { allowed: [] });
    }
    const allowed = allowedCommands(task.status);
    if (!allowed.includes(cmd.type)) {
      throw new DomainError('invalid_transition', 409, `Can't ${cmd.type.replace('_', ' ')} a task that is ${task.status.replace('_', ' ')}.`, { allowed });
    }
    const note = cmd.note?.trim() || null;
    const op = { taskId: task.id, actor: 'operator' as const };

    switch (cmd.type) {
      case 'submit': {
        ctx.emit({ ...op, type: 'task_submitted', summary: withNote('Submitted for routing.', note), payload: { note } });
        dispatch(ctx, task, { round: task.round + 1, retryIndex: 0 });
        break;
      }
      case 'reroute': {
        abandonPending(ctx, task, 'operator_reroute');
        const fresh = repo.getTask(task.id)!;
        ctx.emit({ ...op, type: 'routing_restarted', summary: withNote(`Routing again (round ${task.round + 1}) with a fresh retry budget.`, note), payload: { round: task.round + 1, note } });
        dispatch(ctx, fresh, { round: task.round + 1, retryIndex: 0 });
        break;
      }
      case 'stop_routing': {
        abandonPending(ctx, task, 'operator_stop');
        must(repo.casTask(task.id, { status: 'routing' }, { status: 'new', currentAttemptId: null, statusChangedAt: now, bumpVersion: true }), 'stop routing');
        ctx.emit({ ...op, type: 'routing_stopped', summary: withNote('Stopped routing. The task is back in Not routed; nothing happens until it is routed again.', note), payload: { note } });
        break;
      }
      case 'offer': {
        const c = repo.getContributor(cmd.contributorId);
        if (!c) throw notFound('Contributor', cmd.contributorId);
        const facts = repo.contributorFacts().find((f) => f.id === c.id)!;
        const label = repo.expertiseLabel(task.expertiseId);
        if (!facts.expertise.includes(task.expertiseId)) {
          throw new DomainError('contributor_ineligible', 422, `${c.name} doesn't have ${label} expertise.`, { reason: 'no_expertise' });
        }
        if (facts.availability !== 'available') {
          throw new DomainError('contributor_unavailable', 409, `${c.name} is away.`, { reason: 'away' });
        }
        if (facts.load >= facts.maxActive) {
          throw new DomainError('contributor_unavailable', 409, `${c.name} is at capacity (${facts.load}/${facts.maxActive}).`, { reason: 'at_capacity' });
        }
        const exclusion = repo.exclusions(task.id).get(c.id);
        if (exclusion && !cmd.acknowledgeExclusion) {
          throw new DomainError('exclusion_ack_required', 409, `${c.name} ${EXCLUSION_TEXT[exclusion.status] ?? 'is excluded for this task'}. Confirm to offer anyway.`, { exclusion });
        }
        abandonPending(ctx, task, 'operator_offer');
        const fresh = repo.getTask(task.id)!;
        const assignmentId = createOffer(ctx, fresh, { contributorId: c.id, source: 'operator', attemptId: null, note });
        ctx.emit({
          ...op,
          assignmentId,
          contributorId: c.id,
          type: 'offer_created',
          summary: withNote(
            `Operator offered the task to ${c.name}${exclusion ? `, although ${EXCLUSION_CLAUSE[exclusion.status] ?? 'they are excluded for this task'}` : ''}. ${c.name} has ${secs(policy.offerTtlMs).replace('.0s', 's')} to reply.`,
            note,
          ),
          payload: { source: 'operator', note, overrodeExclusion: Boolean(exclusion), expiresAt: now + policy.offerTtlMs },
        });
        break;
      }
      case 'revoke_offer': {
        const asg = repo.activeAssignment(task.id);
        if (!asg || asg.status !== 'offered') throw new InvariantError(`T-${task.id} is offered without an offered assignment`);
        must(repo.moveAssignment(asg.id, ['offered'], 'revoked', { endedAt: now, note }), 'revoke');
        must(repo.casTask(task.id, { status: 'offered' }, { status: 'new', statusChangedAt: now, bumpVersion: true }), 'revoke task');
        const name = repo.contributorName(asg.contributorId);
        ctx.emit({
          ...op,
          assignmentId: asg.id,
          contributorId: asg.contributorId,
          type: 'offer_revoked',
          summary: withNote(`Operator revoked the offer to ${name}. The task is back in Not routed. ${name} is not excluded.`, note),
          payload: { note },
        });
        break;
      }
      case 'release': {
        if (!note) throw new DomainError('note_required', 400, 'Say why you are releasing this assignment');
        const asg = repo.activeAssignment(task.id);
        if (!asg || asg.status !== 'accepted') throw new InvariantError(`T-${task.id} is assigned without an accepted assignment`);
        must(repo.moveAssignment(asg.id, ['accepted'], 'released', { endedAt: now, note }), 'release');
        toAttention(ctx, task, 'failed_before_start');
        const name = repo.contributorName(asg.contributorId);
        ctx.emit({
          ...op,
          assignmentId: asg.id,
          contributorId: asg.contributorId,
          type: 'assignment_released',
          summary: withNote(`Operator released ${name} before work started. Routing had completed; reopening it is your call. ${name} is excluded from engine routing for this task.`, note),
          payload: { note },
        });
        break;
      }
      case 'cancel': {
        const asg = repo.activeAssignment(task.id);
        // Someone is holding an offer or the work: they'll be told why, so a reason is required (as the UI says).
        if (asg && !note) throw new DomainError('note_required', 400, `Say why you are cancelling: ${repo.contributorName(asg.contributorId)} is affected.`);
        abandonPending(ctx, task, 'task_cancelled');
        if (asg) must(repo.moveAssignment(asg.id, ['offered', 'accepted', 'in_progress'], 'cancelled', { endedAt: now }), 'cancel assignment');
        const fresh = repo.getTask(task.id)!;
        must(
          repo.casTask(task.id, { status: fresh.status }, { status: 'cancelled', attentionReason: null, currentAttemptId: null, closedAt: now, statusChangedAt: now, bumpVersion: true }),
          'cancel task',
        );
        const who = asg ? ` ${repo.contributorName(asg.contributorId)}'s ${asg.status === 'offered' ? 'offer' : 'assignment'} was cancelled.` : '';
        ctx.emit({ ...op, assignmentId: asg?.id ?? null, type: 'task_cancelled', summary: withNote(`Task cancelled.${who}`, note), payload: { note } });
        break;
      }
    }
    // Every operator command moves the version, so a second tab acting on what it saw gets a 409.
    const after = repo.getTask(task.id)!;
    if (after.version === task.version) must(repo.casTask(task.id, { version: task.version }, { bumpVersion: true }), 'bump version');
    log.info('command', { cmd: cmd.type, task: task.id, from: task.status, to: after.status });
    return repo.getTask(task.id)!;
  }

  return {
    repo,
    policy,
    /** Raw transaction, for callers (the sim pump) that combine their own writes with an inner command. */
    transaction: tx,
    setCatchUp(v: boolean) {
      catchUp = v;
    },

    /**
     * Create a task and, optionally, submit it — in ONE transaction, so a failure can't leave a
     * half-done action behind. `onCreated` runs inside that transaction (the simulation uses it to
     * attach demo presets before the first request is dispatched).
     */
    createTask(
      input: { title: string; brief?: string; requestedBy?: string; expertiseId: string; priority: Priority },
      opts: { submit?: boolean; onCreated?: (taskId: number) => void } = {},
      now = clock.now(),
    ): TaskRec {
      return tx(() => {
        const ctx = ctxAt(now);
        const label = repo.expertiseLabel(input.expertiseId);
        if (!label) throw new DomainError('invalid_expertise', 422, `Unknown expertise area "${input.expertiseId}".`);
        const title = input.title.trim();
        if (charCount(title) < 3 || charCount(title) > 120) throw new DomainError('validation_failed', 400, 'Title must be 3–120 characters.');
        if (unsafeText(title) || unsafeText(input.brief ?? '', true) || unsafeText(input.requestedBy ?? '')) {
          throw new DomainError('validation_failed', 400, 'Remove control or invisible characters from the task.');
        }
        const id = repo.insertTask({ title, brief: input.brief ?? '', requestedBy: input.requestedBy ?? '', expertiseId: input.expertiseId, priority: input.priority, now });
        const pri = input.priority === 'normal' ? 'Normal' : input.priority === 'high' ? 'High' : 'Low';
        ctx.emit({ taskId: id, type: 'task_created', actor: 'operator', summary: `Created: ${label} · ${pri} priority.`, payload: { priority: input.priority, expertiseId: input.expertiseId } });
        opts.onCreated?.(id);
        if (opts.submit) return operatorCommandInner(ctx, id, { type: 'submit', expectedVersion: repo.getTask(id)!.version });
        return repo.getTask(id)!;
      });
    },

    command(taskId: number, cmd: ParsedCommand, now = clock.now()): TaskRec {
      return operatorCommand(taskId, cmd, now);
    },

    respond(assignmentId: number, action: ContributorAction, opts: { note?: string | null; simulatedBy?: string } = {}, now = clock.now()): RespondResult {
      return tx(() => respondInner(ctxAt(now), assignmentId, action, opts));
    },

    applyEngineResult(attemptId: number, r: EngineResult, availableAt: number, now = clock.now()): ApplyResult {
      return tx(() => applyEngineResultInner(ctxAt(now), attemptId, r, availableAt));
    },

    enforceDeadlines,

    setAvailability(contributorId: number, availability: 'available' | 'away', now = clock.now()): void {
      tx(() => {
        const c = repo.getContributor(contributorId);
        if (!c) throw notFound('Contributor', contributorId);
        if (repo.setAvailability(contributorId, availability) === 0) return;
        ctxAt(now).emit({
          taskId: null,
          contributorId,
          type: 'contributor_availability_changed',
          actor: 'simulator',
          summary: `${c.name} is now ${availability}. Existing offers and assignments are unchanged; new routing ${availability === 'away' ? 'skips' : 'includes'} ${c.name}.`,
          payload: { availability },
        });
      });
    },

    emitSystem(type: string, summary: string, payload: Record<string, unknown> = {}, now = clock.now()): void {
      tx(() => {
        ctxAt(now).emit({ taskId: null, type, actor: 'system', summary, payload });
      });
    },

    /** Inner (no-transaction) variants for the simulation pump, which marks its job delivered in the same transaction. */
    inner: {
      applyEngineResult: (attemptId: number, r: EngineResult, availableAt: number, now: number) => applyEngineResultInner(ctxAt(now), attemptId, r, availableAt),
      respond: (assignmentId: number, action: ContributorAction, opts: { note?: string | null; simulatedBy?: string }, now: number) => respondInner(ctxAt(now), assignmentId, action, opts),
    },
  };
}

export type Desk = ReturnType<typeof createDesk>;
