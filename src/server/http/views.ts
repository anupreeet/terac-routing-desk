// Read models: rows → API DTOs. Reads never mutate. Nothing here can see the simulation's tables,
// so no response can reveal whether a pending request will ever answer.
import { POLICY, allowedCommands, isOverdue, nextAutomaticAction, type AttentionReason, type Policy } from '../../shared/policy';
import type { ActivityDto, AssignmentDto, AttemptDto, CandidateDto, ContributorDto, EngineHealthDto, EventDto, LateAnswerDto, SnapshotDto, TaskDetailDto, TaskRowDto } from '../../shared/schemas';
import { plural } from '../../shared/format';
import { judgeAll, EXCLUSION_TEXT } from '../domain/eligibility';
import type { AssignmentRec, AttemptRec, EventRec, Repo, TaskRec } from '../store/repo';

export function createViews(repo: Repo, policy: Policy = POLICY) {
  const name = (id: number) => repo.contributorName(id);

  function attentionFor(task: TaskRec, reason: AttentionReason, attempts: AttemptRec[], last: AssignmentRec | undefined): TaskRowDto['attention'] {
    const label = repo.expertiseLabel(task.expertiseId) ?? task.expertiseId;
    const verdicts = judgeAll(repo.contributorFacts(), task.expertiseId, repo.exclusions(task.id));
    const free = verdicts.filter((v) => !v.blocker).length;
    const stillEligible = free === 0 ? 'Nobody eligible is free right now.' : `${plural(free, 'contributor')} can take it now.`;
    const lastName = last ? name(last.contributorId) : 'The contributor';
    const quoted = last?.note ? ` “${last.note}”` : '';
    switch (reason) {
      case 'no_eligible_contributors': {
        if (verdicts.length === 0) {
          return { reason, title: 'No one can take this', short: `No one covers ${label}`, detail: `No contributor has ${label} expertise, so the engine was not called.` };
        }
        const counts = (['away', 'at_capacity', 'excluded'] as const)
          .map((b) => [b, verdicts.filter((v) => v.blocker === b).length] as const)
          .filter(([, n]) => n > 0)
          .map(([b, n]) => `${n} ${b === 'at_capacity' ? 'at capacity' : b === 'excluded' ? 'excluded for this task' : 'away'}`);
        return {
          reason,
          title: 'No one can take this right now',
          short: `No ${label} contributor free`,
          detail: `${plural(verdicts.length, 'contributor')} ${verdicts.length === 1 ? 'has' : 'have'} ${label} expertise: ${counts.join(', ') || 'none free'}. The engine was not called. ${free > 0 ? stillEligible : ''}`.trim(),
        };
      }
      case 'no_match': {
        const a = [...attempts].reverse().find((x) => x.status === 'no_match');
        return {
          reason,
          title: 'Engine found no match',
          short: 'Engine found no match',
          detail: `Request #${a?.seq ?? '?'} reviewed ${plural(a?.candidates.length ?? 0, 'candidate')} and picked no one. We don't retry a definite no-match. ${stillEligible}`,
        };
      }
      case 'routing_exhausted': {
        const inRound = attempts.filter((x) => x.round === task.round);
        const timedOut = inRound.filter((x) => x.status === 'timed_out').length;
        return {
          reason,
          title: 'Engine gave no usable answer',
          short: `No answer after ${plural(inRound.length, 'request')}`,
          detail: `${plural(inRound.length, 'request')} this round${timedOut ? `, ${timedOut} with no answer before we stopped waiting` : ''}. The engine may be degraded, or this may be bad luck; we can't tell. Late answers, if any, appear below. ${stillEligible}`,
        };
      }
      case 'declined':
        return { reason, title: `${lastName} declined`, short: `${lastName} declined`, detail: `${lastName} declined.${quoted} ${lastName} is excluded from engine routing for this task. ${stillEligible}` };
      case 'offer_expired':
        return { reason, title: `${lastName} didn't reply`, short: `${lastName} didn't reply`, detail: `No reply within the offer window. ${lastName} is excluded from engine routing for this task (you can still offer it to them). ${stillEligible}` };
      case 'failed_before_start': {
        const how = last?.status === 'released' ? 'was released by the operator' : 'withdrew';
        return {
          reason,
          title: 'Fell through before work started',
          short: `${lastName} ${last?.status === 'released' ? 'released' : 'withdrew'}`,
          detail: `${lastName} accepted, then ${how} before starting.${quoted} Routing had completed; reopening it is your call. ${stillEligible}`,
        };
      }
    }
  }

  function taskRow(task: TaskRec, attempts = repo.attemptsForTask(task.id)): TaskRowDto {
    const label = repo.expertiseLabel(task.expertiseId) ?? task.expertiseId;
    const cur = task.currentAttemptId !== null ? attempts.find((a) => a.id === task.currentAttemptId) ?? null : null;
    const active = repo.activeAssignment(task.id);
    const last = repo.lastAssignment(task.id);
    const seqOf = (attemptId: number | null) => (attemptId === null ? null : (attempts.find((a) => a.id === attemptId)?.seq ?? null));
    const activeDto = active
      ? {
          id: active.id,
          contributorId: active.contributorId,
          contributorName: name(active.contributorId),
          status: active.status,
          source: active.source,
          attemptSeq: seqOf(active.attemptId),
          offeredAt: active.offeredAt,
          expiresAt: active.expiresAt,
          respondedAt: active.respondedAt,
          startedAt: active.startedAt,
        }
      : null;
    const curDto = cur
      ? { id: cur.id, seq: cur.seq, round: cur.round, retryIndex: cur.retryIndex, dispatchedAt: cur.dispatchedAt, deadlineAt: cur.deadlineAt, candidateCount: cur.candidates.length }
      : null;
    return {
      id: task.id,
      title: task.title,
      expertiseId: task.expertiseId,
      expertiseLabel: label,
      priority: task.priority,
      status: task.status,
      attention: task.status === 'needs_attention' && task.attentionReason ? attentionFor(task, task.attentionReason, attempts, last) : null,
      version: task.version,
      round: task.round,
      createdAt: task.createdAt,
      statusChangedAt: task.statusChangedAt,
      closedAt: task.closedAt,
      currentAttempt: curDto,
      activeAssignment: activeDto,
      lastOutcome: last ? { contributorName: name(last.contributorId), status: last.status, note: last.note, endedAt: last.endedAt } : null,
      wasRouted: task.round > 0 || attempts.length > 0 || Boolean(last),
      nextAutomaticAction: nextAutomaticAction({ status: task.status, currentAttempt: curDto, activeAssignment: activeDto }, policy),
      allowedCommands: allowedCommands(task.status),
    };
  }

  function eventDto(e: EventRec): EventDto {
    return { ...e };
  }

  function attemptDto(a: AttemptRec): AttemptDto {
    const applied = a.status === 'matched' || a.status === 'no_match';
    return {
      id: a.id,
      seq: a.seq,
      round: a.round,
      retryIndex: a.retryIndex,
      status: a.status,
      abandonReason: a.abandonReason,
      candidates: a.candidates,
      excluded: a.excluded,
      dispatchedAt: a.dispatchedAt,
      deadlineAt: a.deadlineAt,
      closedAt: a.closedAt,
      result:
        a.resultKind && a.resultAt !== null
          ? {
              kind: a.resultKind,
              contributorId: a.resultContributorId,
              contributorName: a.resultContributorId !== null ? name(a.resultContributorId) : null,
              at: a.resultAt,
              reason: a.resultReason,
              applied,
            }
          : null,
      invalidReason: a.invalidReason,
    };
  }

  function assignmentDto(x: AssignmentRec, attempts: AttemptRec[]): AssignmentDto {
    return {
      id: x.id,
      contributorId: x.contributorId,
      contributorName: name(x.contributorId),
      source: x.source,
      attemptSeq: x.attemptId === null ? null : (attempts.find((a) => a.id === x.attemptId)?.seq ?? null),
      status: x.status,
      offeredAt: x.offeredAt,
      expiresAt: x.expiresAt,
      respondedAt: x.respondedAt,
      startedAt: x.startedAt,
      endedAt: x.endedAt,
      note: x.note,
    };
  }

  function taskDetail(taskId: number): TaskDetailDto | null {
    const task = repo.getTask(taskId);
    if (!task) return null;
    const attempts = repo.attemptsForTask(task.id);
    const row = taskRow(task, attempts);
    const exclusions = repo.exclusions(task.id);
    const verdicts = judgeAll(repo.contributorFacts(), task.expertiseId, exclusions);
    const headlines = new Map(repo.contributorList().map((c) => [c.id, c.headline]));
    const canOffer = row.allowedCommands.includes('offer');

    const candidates: CandidateDto[] = verdicts
      .map((v) => ({
        contributorId: v.contributor.id,
        name: v.contributor.name,
        headline: headlines.get(v.contributor.id) ?? '',
        load: v.contributor.load,
        maxActive: v.contributor.maxActive,
        availability: v.contributor.availability,
        blocker: v.blocker === 'no_expertise' ? null : v.blocker,
        exclusion: v.exclusion ? { status: v.exclusion.status, at: v.exclusion.at, note: v.exclusion.note } : null,
      }))
      .sort((a, b) => Number(a.blocker !== null) - Number(b.blocker !== null) || a.load / a.maxActive - b.load / b.maxActive || a.name.localeCompare(b.name));

    const lateAnswers: LateAnswerDto[] = attempts
      .filter((a) => a.resultKind === 'match' && a.resultContributorId !== null && (a.status === 'timed_out' || a.status === 'abandoned'))
      .map((a) => {
        const c = candidates.find((x) => x.contributorId === a.resultContributorId);
        let whyNot: string | null = null;
        if (!canOffer) whyNot = row.status === 'offered' ? 'Someone already has an open offer' : `Can't offer while the task is ${row.status.replace('_', ' ')}`;
        else if (!c) whyNot = 'No longer has this expertise';
        else if (c.blocker === 'away') whyNot = 'Away';
        else if (c.blocker === 'at_capacity') whyNot = `At capacity (${c.load}/${c.maxActive})`;
        else if (c.blocker === 'excluded') whyNot = `Excluded: ${EXCLUSION_TEXT[c.exclusion!.status] ?? 'excluded'}`;
        return {
          attemptId: a.id,
          attemptSeq: a.seq,
          contributorId: a.resultContributorId,
          contributorName: a.resultContributorId !== null ? name(a.resultContributorId) : null,
          at: a.resultAt!,
          offerableNow: whyNot === null,
          whyNot,
        };
      });

    const final = row.status === 'completed' || row.status === 'cancelled';
    return {
      ...row,
      brief: task.brief,
      requestedBy: task.requestedBy,
      attempts: attempts.map(attemptDto),
      assignments: repo.assignmentsForTask(task.id).map((x) => assignmentDto(x, attempts)),
      events: repo.eventsForTask(task.id).map(eventDto),
      candidates,
      lateAnswers,
      sim: { deliverableAttemptIds: attempts.filter((a) => a.resultAt === null && (a.status === 'pending' || !final)).map((a) => a.id) },
    };
  }

  /** Counts of what requests did; never a prediction about a pending one. */
  function engineHealth(now: number): EngineHealthDto {
    const attempts = repo.attemptsDispatchedSince(now - policy.engineHealthWindowMs);
    const count = (s: AttemptRec['status']) => attempts.filter((a) => a.status === s).length;
    const latencies = attempts
      .filter((a) => (a.status === 'matched' || a.status === 'no_match' || a.status === 'invalid_result') && a.resultAt !== null)
      .map((a) => a.resultAt! - a.dispatchedAt)
      .sort((x, y) => x - y);
    const quantile = (p: number) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] : null);
    return {
      windowMs: policy.engineHealthWindowMs,
      sent: attempts.length,
      pending: count('pending'),
      overdue: attempts.filter((a) => a.status === 'pending' && isOverdue(a.dispatchedAt, now, policy)).length,
      answered: latencies.length,
      matched: count('matched'),
      noMatch: count('no_match'),
      notApplied: count('invalid_result'),
      noAnswerByDeadline: count('timed_out'),
      stoppedByOperator: count('abandoned'),
      lateAnswers: attempts.filter((a) => (a.status === 'timed_out' || a.status === 'abandoned') && a.resultAt !== null).length,
      medianAnswerMs: quantile(0.5),
      p90AnswerMs: quantile(0.9),
    };
  }

  function activity(limit: number, before?: number): ActivityDto {
    const events = repo.recentEvents(limit + 1, before);
    const page = events.slice(0, limit);
    const titles = repo.taskTitles([...new Set(page.map((e) => e.taskId).filter((id): id is number => id !== null))]);
    return {
      events: page.map((e) => ({ ...eventDto(e), taskTitle: e.taskId !== null ? (titles.get(e.taskId) ?? null) : null })),
      nextBefore: events.length > limit ? page.at(-1)!.id : null,
    };
  }

  function snapshot(now: number, boot: { bootId: string; bootedAt: number }): SnapshotDto {
    const tasks = repo.listTasks();
    const rows = tasks.map((t) => taskRow(t));
    const routing = rows.filter((r) => r.status === 'routing');
    const offered = rows.filter((r) => r.status === 'offered');
    const attention = rows.filter((r) => r.status === 'needs_attention');
    const contributors = repo.contributorList();
    const areas = repo.expertiseAreas();
    const labelOf = new Map(areas.map((a) => [a.id, a.label]));
    const lastBootEvent = repo.lastEventOfTypes(['desk_restarted', 'desk_started']);

    const contributorDtos: ContributorDto[] = contributors.map((c) => ({
      id: c.id,
      name: c.name,
      headline: c.headline,
      expertise: c.expertise.map((id) => ({ id, label: labelOf.get(id) ?? id })),
      availability: c.availability,
      load: c.load,
      maxActive: c.maxActive,
      activeTaskIds: c.activeTaskIds,
    }));

    return {
      serverNow: now,
      bootId: boot.bootId,
      bootedAt: boot.bootedAt,
      lastBoot: lastBootEvent
        ? { at: lastBootEvent.at, offlineMs: (lastBootEvent.payload.offlineMs as number | undefined) ?? null, summary: lastBootEvent.summary }
        : null,
      policy,
      counts: {
        attention: attention.length,
        attentionHigh: attention.filter((r) => r.priority === 'high').length,
        routing: routing.length,
        overdue: routing.filter((r) => r.currentAttempt && isOverdue(r.currentAttempt.dispatchedAt, now, policy)).length,
        offered: offered.length,
        nextOfferExpiry: offered.reduce<number | null>((m, r) => (r.activeAssignment && (m === null || r.activeAssignment.expiresAt < m) ? r.activeAssignment.expiresAt : m), null),
        working: rows.filter((r) => r.status === 'assigned' || r.status === 'in_progress').length,
        notRouted: rows.filter((r) => r.status === 'new').length,
        done: rows.filter((r) => r.status === 'completed').length,
        cancelled: rows.filter((r) => r.status === 'cancelled').length,
      },
      engine: engineHealth(now),
      tasks: rows,
      contributors: contributorDtos,
      expertise: areas.map((a) => ({
        id: a.id,
        label: a.label,
        contributorCount: contributors.filter((c) => c.expertise.includes(a.id)).length,
        offerableCount: contributors.filter((c) => c.expertise.includes(a.id) && c.availability === 'available' && c.load < c.maxActive).length,
      })),
    };
  }

  return { taskRow, taskDetail, snapshot, eventDto, engineHealth, activity };
}

export type Views = ReturnType<typeof createViews>;
