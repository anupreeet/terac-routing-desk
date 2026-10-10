// Shared routing steps. All run inside a transaction opened by a public command.
import type { AbandonReason, AttentionReason } from '../../shared/policy';
import { requestsPerRound } from '../../shared/policy';
import { plural, secs } from '../../shared/format';
import { BLOCKER_TEXT, EXCLUSION_TEXT, judgeAll } from '../domain/eligibility';
import type { AttemptRec, CandidateSnap, ExcludedSnap, TaskRec } from '../store/repo';
import { must, type Ctx } from './context';

const ABANDON_TEXT: Record<AbandonReason, string> = {
  operator_offer: 'the operator offered the task directly',
  operator_reroute: 'the operator re-routed the task',
  operator_stop: 'the operator stopped routing',
  task_cancelled: 'the task was cancelled',
};

export function snapshotCandidates(ctx: Ctx, task: TaskRec): { candidates: CandidateSnap[]; excluded: ExcludedSnap[]; total: number } {
  const verdicts = judgeAll(ctx.repo.contributorFacts(), task.expertiseId, ctx.repo.exclusions(task.id));
  const candidates: CandidateSnap[] = [];
  const excluded: ExcludedSnap[] = [];
  for (const v of verdicts) {
    const c = v.contributor;
    if (!v.blocker) candidates.push({ contributorId: c.id, name: c.name, load: c.load, maxActive: c.maxActive });
    else {
      const reason =
        v.blocker === 'excluded' && v.exclusion
          ? (EXCLUSION_TEXT[v.exclusion.status] ?? 'excluded for this task')
          : v.blocker === 'at_capacity'
            ? `at capacity, ${c.load} of ${c.maxActive}`
            : BLOCKER_TEXT[v.blocker];
      excluded.push({ contributorId: c.id, name: c.name, reason });
    }
  }
  return { candidates, excluded, total: verdicts.length };
}

function excludedText(excluded: ExcludedSnap[]): string {
  return excluded.length ? ` Not sent: ${excluded.map((e) => `${e.name} (${e.reason})`).join(', ')}.` : '';
}

/**
 * Send a new request to the engine for this task, or — if nobody can take it — skip the engine
 * entirely and hand the task to the operator. Returns the new attempt id, or null.
 */
export function dispatch(ctx: Ctx, task: TaskRec, opts: { round: number; retryIndex: number }): number | null {
  const { repo, now, policy } = ctx;
  const label = repo.expertiseLabel(task.expertiseId) ?? task.expertiseId;
  const { candidates, excluded, total } = snapshotCandidates(ctx, task);

  if (candidates.length === 0) {
    toAttention(ctx, task, 'no_eligible_contributors', { round: opts.round });
    const summary =
      total === 0
        ? `Not sent to the engine: no contributor has ${label} expertise.`
        : `Not sent to the engine: none of the ${plural(total, `${label} contributor`)} can take it right now.${excludedText(excluded)}`;
    ctx.emit({ type: 'routing_no_candidates', actor: 'system', taskId: task.id, summary, payload: { round: opts.round, excluded } });
    return null;
  }

  const seq = repo.nextSeq(task.id);
  const timeoutMs = policy.requestDeadlineMs[task.priority];
  const attemptId = repo.insertAttempt({
    taskId: task.id,
    round: opts.round,
    seq,
    retryIndex: opts.retryIndex,
    candidates,
    excluded,
    dispatchedAt: now,
    deadlineAt: now + timeoutMs,
  });
  const statusChanges = task.status !== 'routing';
  must(
    repo.casTask(
      task.id,
      { status: task.status, currentAttemptId: task.currentAttemptId },
      {
        status: 'routing',
        attentionReason: null,
        currentAttemptId: attemptId,
        round: opts.round,
        ...(statusChanges ? { statusChangedAt: now, bumpVersion: true } : {}),
      },
    ),
    `dispatch T-${task.id}`,
  );
  ctx.engine.dispatch({
    attemptId,
    taskId: task.id,
    seq,
    expertiseId: task.expertiseId,
    expertiseLabel: label,
    priority: task.priority,
    candidates,
    dispatchedAt: now,
  });
  const perRound = requestsPerRound(policy);
  const retryText = opts.retryIndex > 0 ? ` (retry ${opts.retryIndex} of ${policy.retriesPerRound})` : '';
  ctx.emit({
    type: 'attempt_dispatched',
    actor: 'system',
    taskId: task.id,
    attemptId,
    summary: `Request #${seq}${retryText} sent to the engine with ${plural(candidates.length, 'candidate')}: ${candidates
      .map((c) => c.name)
      .join(', ')}.${excludedText(excluded)} We stop waiting after ${secs(timeoutMs).replace('.0s', 's')}.`,
    payload: { seq, round: opts.round, retryIndex: opts.retryIndex, requestOf: perRound, candidateIds: candidates.map((c) => c.contributorId), deadlineAt: now + timeoutMs },
  });
  return attemptId;
}

/** Stop automation and hand the task to the operator. */
export function toAttention(ctx: Ctx, task: TaskRec, reason: AttentionReason, extra: { round?: number } = {}): void {
  must(
    ctx.repo.casTask(
      task.id,
      { status: task.status, currentAttemptId: task.currentAttemptId },
      {
        status: 'needs_attention',
        attentionReason: reason,
        currentAttemptId: null,
        statusChangedAt: ctx.now,
        bumpVersion: true,
        ...(extra.round !== undefined ? { round: extra.round } : {}),
      },
    ),
    `toAttention T-${task.id}`,
  );
}

/** After a machine failure (timeout or unusable pick): retry within the round's budget, or escalate. */
export function retryOrEscalate(ctx: Ctx, taskId: number): void {
  const task = ctx.repo.getTask(taskId)!;
  const used = ctx.repo.attemptsInRound(task.id, task.round);
  const perRound = requestsPerRound(ctx.policy);
  if (used < perRound) {
    dispatch(ctx, task, { round: task.round, retryIndex: used });
    return;
  }
  toAttention(ctx, task, 'routing_exhausted');
  ctx.emit({
    type: 'routing_exhausted',
    actor: 'system',
    taskId: task.id,
    summary: `${plural(perRound, 'request')} in this round produced no usable answer. Automatic retries are used up; the task needs your decision. Late answers, if any arrive, will appear here.`,
    payload: { round: task.round, requests: used },
  });
}

/** Close the task's pending request because a person acted. Its answer may still arrive; it will be recorded, not applied. */
export function abandonPending(ctx: Ctx, task: TaskRec, reason: AbandonReason): AttemptRec | null {
  if (task.currentAttemptId === null) return null;
  const a = ctx.repo.getAttempt(task.currentAttemptId)!;
  must(ctx.repo.closeAttempt(a.id, 'abandoned', ctx.now, { abandonReason: reason }), `abandon attempt ${a.id}`);
  ctx.emit({
    type: 'attempt_abandoned',
    actor: 'system',
    taskId: task.id,
    attemptId: a.id,
    summary: `Stopped waiting for request #${a.seq} after ${secs(ctx.now - a.dispatchedAt)}: ${ABANDON_TEXT[reason]}. If it answers later, the answer is recorded, not applied.`,
    payload: { seq: a.seq, reason },
  });
  return a;
}

/** Create an offer (engine pick or operator pick — one lifecycle) and notify the contributor. */
export function createOffer(
  ctx: Ctx,
  task: TaskRec,
  o: { contributorId: number; source: 'engine' | 'operator'; attemptId: number | null; note?: string | null },
): number {
  const { repo, now, policy } = ctx;
  const expiresAt = now + policy.offerTtlMs;
  const assignmentId = repo.insertOffer({
    taskId: task.id,
    contributorId: o.contributorId,
    source: o.source,
    attemptId: o.attemptId,
    offeredAt: now,
    expiresAt,
    note: o.note ?? null,
  });
  must(
    repo.casTask(
      task.id,
      { status: task.status, currentAttemptId: task.currentAttemptId },
      { status: 'offered', attentionReason: null, currentAttemptId: null, statusChangedAt: now, bumpVersion: true },
    ),
    `offer T-${task.id}`,
  );
  ctx.channel.offerCreated({ assignmentId, taskId: task.id, contributorId: o.contributorId, offeredAt: now, expiresAt });
  return assignmentId;
}

/** Why a late engine answer was not applied, in the operator's terms. */
export function explainLate(ctx: Ctx, attempt: AttemptRec, task: TaskRec): string {
  if (task.status === 'cancelled') return 'the task was cancelled';
  if (attempt.status === 'timed_out') {
    const waited = secs(attempt.deadlineAt - attempt.dispatchedAt).replace('.0s', 's');
    if (task.status === 'routing' && task.currentAttemptId !== null) {
      const cur = ctx.repo.getAttempt(task.currentAttemptId);
      return `we had stopped waiting at ${waited}${cur ? ` and request #${cur.seq} is now pending` : ''}`;
    }
    return `we had stopped waiting at ${waited}`;
  }
  if (attempt.status === 'abandoned' && attempt.abandonReason) {
    if (attempt.abandonReason === 'operator_offer') {
      const offer = ctx.repo.assignmentsForTask(task.id).find((a) => a.source === 'operator' && a.offeredAt >= (attempt.closedAt ?? 0));
      return offer ? `the operator had already offered the task to ${ctx.repo.contributorName(offer.contributorId)}` : 'the operator had already offered the task directly';
    }
    return ABANDON_TEXT[attempt.abandonReason].replace('the operator ', 'the operator had ').replace('the task was', 'the task had been');
  }
  return 'the request was already closed';
}
