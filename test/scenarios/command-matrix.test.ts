// The intervention matrix as an executable specification. Every task state × every operator command,
// and every assignment state × every contributor action:
//   - allowed  → succeeds, lands in the documented status, writes exactly the documented events;
//   - refused  → a DomainError / HTTP 409, and the task, its requests, its assignments and the
//                event log are byte-for-byte unchanged.
// The harness checks every invariant (R1 one active assignment, R2 one pending request, R10 never
// both, …) after every step, and each case re-checks them at the end.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, ANA, BEN, type Harness } from '../helpers/harness';
import { ASSIGNMENT_STATES, TASK_STATES, footprint, named, newEventTypes, type TaskState } from '../helpers/states';
import {
  ACTIVE_ASSIGNMENT_STATUSES,
  CONTRIBUTOR_ACTIONS,
  OPERATOR_COMMANDS,
  allowedCommands,
  isFinal,
  type AbandonReason,
  type AssignmentStatus,
  type AttentionReason,
  type ContributorAction,
  type OperatorCommand,
  type TaskStatus,
} from '../../src/shared/policy';
import { ApiErrorDto, TaskDetailDto, type DistributiveOmit, type ParsedCommand } from '../../src/shared/schemas';
import { DomainError } from '../../src/server/domain/errors';
import { checkInvariants } from '../../src/server/infra/invariants';

let h: Harness;
afterEach(() => h?.close());

const BODY: Record<OperatorCommand, DistributiveOmit<ParsedCommand, 'expectedVersion'>> = {
  submit: { type: 'submit' },
  offer: { type: 'offer', contributorId: BEN },
  reroute: { type: 'reroute' },
  stop_routing: { type: 'stop_routing' },
  revoke_offer: { type: 'revoke_offer' },
  release: { type: 'release', note: 'No-show for kickoff' },
  cancel: { type: 'cancel', note: 'Client paused the project' },
};

interface Expected {
  status: TaskStatus;
  attention: AttentionReason | null;
  events: string[];
  /** The pending request, if there was one, is closed with this reason. */
  abandoned: AbandonReason | null;
  /** The active assignment, if there was one, ends in this status. */
  ended: AssignmentStatus | null;
  /** A new request is sent to the engine. */
  dispatches: boolean;
}

/** The documented outcome of an allowed command (PLAN §3.3 TT-02…TT-20 with amendment A1). */
function expectedAfter(state: TaskState, cmd: OperatorCommand): Expected {
  const wasRouting = state.status === 'routing';
  const abandon = (r: AbandonReason) => (wasRouting ? r : null);
  const pre = wasRouting ? ['attempt_abandoned'] : [];
  switch (cmd) {
    case 'submit':
      return { status: 'routing', attention: null, events: ['task_submitted', 'attempt_dispatched'], abandoned: null, ended: null, dispatches: true };
    case 'offer':
      return { status: 'offered', attention: null, events: [...pre, 'offer_created'], abandoned: abandon('operator_offer'), ended: null, dispatches: false };
    case 'reroute':
      return { status: 'routing', attention: null, events: [...pre, 'routing_restarted', 'attempt_dispatched'], abandoned: abandon('operator_reroute'), ended: null, dispatches: true };
    case 'stop_routing':
      return { status: 'new', attention: null, events: ['attempt_abandoned', 'routing_stopped'], abandoned: 'operator_stop', ended: null, dispatches: false };
    case 'revoke_offer':
      return { status: 'new', attention: null, events: ['offer_revoked'], abandoned: null, ended: 'revoked', dispatches: false };
    case 'release':
      return { status: 'needs_attention', attention: 'failed_before_start', events: ['assignment_released'], abandoned: null, ended: 'released', dispatches: false };
    case 'cancel': {
      const engaged = ['offered', 'assigned', 'in_progress'].includes(state.status);
      return { status: 'cancelled', attention: null, events: [...pre, 'task_cancelled'], abandoned: abandon('task_cancelled'), ended: engaged ? 'cancelled' : null, dispatches: false };
    }
  }
}

const PAIRS = TASK_STATES.flatMap((state) =>
  OPERATOR_COMMANDS.map((cmd) => {
    const allowed = allowedCommands(state.status).includes(cmd);
    const exp = allowed ? expectedAfter(state, cmd) : null;
    const name = allowed
      ? `${state.name} + ${cmd} → ${exp!.status}${exp!.attention ? ` (${exp!.attention})` : ''}, writing ${exp!.events.join(', ')}`
      : `${state.name} + ${cmd} is refused and changes nothing`;
    return { name, state, cmd, allowed, exp };
  }),
);

describe('state reachability: every task status and every attention reason can be reached through the public commands', () => {
  it.each(named(TASK_STATES))('%s', (_name, s) => {
    h = createHarness({ world: 'spy' });
    const id = s.reach(h);
    expect(h.task(id).status).toBe(s.status);
    expect(h.task(id).attentionReason).toBe(s.attention);
    expect(checkInvariants(h.sql)).toEqual([]);
  });

  it('the fixtures cover every task status and every attention reason the desk can produce', () => {
    const statuses = new Set(TASK_STATES.map((s) => s.status));
    expect([...statuses].sort()).toEqual(['assigned', 'cancelled', 'completed', 'in_progress', 'needs_attention', 'new', 'offered', 'routing']);
    const reasons = new Set(TASK_STATES.map((s) => s.attention).filter(Boolean));
    expect([...reasons].sort()).toEqual(['declined', 'failed_before_start', 'no_eligible_contributors', 'no_match', 'offer_expired', 'routing_exhausted']);
  });
});

describe('operator commands × task states (desk)', () => {
  it.each(named(PAIRS.filter((p) => p.allowed)))('%s', (_name, { state, cmd, exp }) => {
    h = createHarness({ world: 'spy' });
    const id = state.reach(h);
    const before = h.task(id);
    const pendingBefore = before.currentAttemptId;
    const activeBefore = h.active(id);
    const eventsBefore = h.types(id).length;
    const requestsBefore = h.app.spy!.engine.requests.length;

    h.app.desk.command(id, { ...BODY[cmd], expectedVersion: before.version } as ParsedCommand);
    h.assertInvariants();

    const after = h.task(id);
    expect(after.status).toBe(exp!.status);
    expect(after.attentionReason).toBe(exp!.attention);
    expect(newEventTypes(h, id, eventsBefore)).toEqual(exp!.events);
    expect(after.version, 'every operator command moves the version').toBeGreaterThan(before.version);
    expect(h.repo.eventsForTask(id).slice(eventsBefore).every((e) => e.at === h.clock.now())).toBe(true);

    if (exp!.abandoned) {
      const a = h.repo.getAttempt(pendingBefore!)!;
      expect(a.status).toBe('abandoned');
      expect(a.abandonReason).toBe(exp!.abandoned);
    }
    if (activeBefore && exp!.ended) expect(h.repo.getAssignment(activeBefore.id)!.status).toBe(exp!.ended);
    if (activeBefore && !exp!.ended) expect(h.repo.getAssignment(activeBefore.id)!.status).toBe(activeBefore.status);

    expect(h.app.spy!.engine.requests.length).toBe(requestsBefore + (exp!.dispatches ? 1 : 0));
    if (exp!.dispatches) {
      const fresh = h.attempts(id).at(-1)!;
      expect(fresh.status).toBe('pending');
      expect(fresh.retryIndex).toBe(0);
      expect(after.round).toBe(before.round + 1);
      expect(after.currentAttemptId).toBe(fresh.id);
    }
    if (cmd === 'offer') {
      const offer = h.active(id)!;
      expect(offer).toMatchObject({ contributorId: BEN, source: 'operator', status: 'offered', attemptId: null });
      expect(offer.expiresAt).toBe(h.clock.now() + h.app.policy.offerTtlMs);
    }
    if (isFinal(after.status)) {
      expect(after.closedAt).toBe(h.clock.now());
      expect(h.active(id)).toBeUndefined();
      expect(after.currentAttemptId).toBeNull();
    }
  });

  it.each(named(PAIRS.filter((p) => !p.allowed)))('%s', (_name, { state, cmd }) => {
    h = createHarness({ world: 'spy' });
    const id = state.reach(h);
    const before = footprint(h, id);
    const v = h.task(id).version;

    let err: unknown;
    try {
      h.app.desk.command(id, { ...BODY[cmd], expectedVersion: v } as ParsedCommand);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DomainError);
    const d = err as DomainError;
    expect(d.status).toBe(409);
    expect(d.code).toBe('invalid_transition');
    expect(d.details.allowed).toEqual(allowedCommands(state.status));
    if (isFinal(state.status)) expect(d.message).toMatch(/nothing more can be done/);
    expect(footprint(h, id)).toBe(before);
    h.assertInvariants();
  });
});

describe('operator commands × task states (HTTP): refusals are a 409 that hands back the current task', () => {
  it.each(named(PAIRS.filter((p) => !p.allowed)))('%s', async (_name, { state, cmd }) => {
    h = createHarness({ world: 'spy' });
    const id = state.reach(h);
    const before = footprint(h, id);
    const res = await h.http.post(`/api/tasks/${id}/commands`).send({ ...BODY[cmd], expectedVersion: h.task(id).version });
    expect(res.status).toBe(409);
    expect(ApiErrorDto.safeParse(res.body).success).toBe(true);
    expect(res.body.error).toMatchObject({ code: 'invalid_transition', allowed: allowedCommands(state.status), unseen: [] });
    expect(TaskDetailDto.safeParse(res.body.error.task).success).toBe(true);
    expect(res.body.error.task.status).toBe(state.status);
    expect(footprint(h, id)).toBe(before);
  });

  it.each(named(PAIRS.filter((p) => p.allowed)))('%s', async (_name, { state, cmd, exp }) => {
    h = createHarness({ world: 'spy' });
    const id = state.reach(h);
    const res = await h.http.post(`/api/tasks/${id}/commands`).send({ ...BODY[cmd], expectedVersion: h.task(id).version, note: cmd === 'release' ? 'No-show' : 'via HTTP' });
    expect(res.status).toBe(200);
    const parsed = TaskDetailDto.safeParse(res.body.task);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(res.body.task.status).toBe(exp!.status);
    expect(res.body.task.allowedCommands).toEqual(allowedCommands(exp!.status));
    // The note travels with the operator's event.
    const opEvent = res.body.task.events.filter((e: { actor: string }) => e.actor === 'operator').at(-1);
    expect(opEvent.payload.note).toBe(cmd === 'release' ? 'No-show' : 'via HTTP');
  });
});

describe('stale expectedVersion (R11): checked before anything else, answered with 409 and the unseen events', () => {
  it.each(named(TASK_STATES))('%s: a command carrying an old version is refused with what changed since', async (_name, s) => {
    h = createHarness({ world: 'spy' });
    const id = s.reach(h);
    const firstEvent = h.repo.eventsForTask(id)[0];
    const before = footprint(h, id);
    const v = h.task(id).version;
    // Pick a command that would otherwise be valid, so only the version can be the reason.
    const cmd = allowedCommands(s.status)[0] ?? 'cancel';
    const res = await h.http.post(`/api/tasks/${id}/commands`).send({ ...BODY[cmd], expectedVersion: v - 1, seenEventId: firstEvent.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('version_conflict');
    expect(res.body.error.currentVersion).toBe(v);
    expect(res.body.error.unseen.map((e: { id: number }) => e.id)).toEqual(h.repo.eventsForTaskAfter(id, firstEvent.id).map((e) => e.id));
    expect(res.body.error.task.version).toBe(v);
    expect(footprint(h, id)).toBe(before);
  });

  it('a version from the future is as stale as one from the past', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    const before = footprint(h, id);
    expect(() => h.app.desk.command(id, { type: 'cancel', expectedVersion: h.task(id).version + 1 })).toThrow(expect.objectContaining({ code: 'version_conflict' }));
    expect(footprint(h, id)).toBe(before);
  });

  it('the version check comes before the status check: a stale command that is also invalid reports the conflict', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ submit: false });
    expect(() => h.app.desk.command(id, { type: 'release', note: 'x', expectedVersion: 0 })).toThrow(expect.objectContaining({ code: 'version_conflict' }));
  });

  it('without seenEventId the 409 still carries the current task, with an empty unseen list', async () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    const res = await h.http.post(`/api/tasks/${id}/commands`).send({ type: 'cancel', expectedVersion: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error.unseen).toEqual([]);
    expect(res.body.error.task.id).toBe(id);
  });

  it('a double click: the second identical command is refused because the first moved the version', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    const v = h.task(id).version;
    h.app.desk.command(id, { type: 'offer', contributorId: BEN, expectedVersion: v });
    const before = footprint(h, id);
    expect(() => h.app.desk.command(id, { type: 'offer', contributorId: BEN, expectedVersion: v })).toThrow(expect.objectContaining({ code: 'version_conflict' }));
    expect(footprint(h, id)).toBe(before);
    expect(h.repo.assignmentsForTask(id)).toHaveLength(1);
  });
});

describe('version rule (R11): background work never bumps the version, so it never causes a spurious 409', () => {
  it('an automatic retry after a timeout keeps the version', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ priority: 'high' });
    const v = h.task(id).version;
    h.advance(h.app.policy.requestDeadlineMs.high);
    expect(h.attempts(id).map((a) => a.status)).toEqual(['timed_out', 'pending']);
    expect(h.task(id).version).toBe(v);
  });

  it('a recorded late answer keeps the version', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ priority: 'high' });
    h.advance(h.app.policy.requestDeadlineMs.high);
    const v = h.task(id).version;
    expect(h.deliver(id, 1, { kind: 'match', contributorId: ANA }).reason).toBe('late');
    expect(h.task(id).version).toBe(v);
  });

  it('a duplicate answer keeps the version', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    h.deliver(id, 1, { kind: 'match', contributorId: ANA });
    const v = h.task(id).version;
    expect(h.deliver(id, 1, { kind: 'match', contributorId: ANA }).reason).toBe('duplicate');
    expect(h.task(id).version).toBe(v);
  });

  it('a contributor reply to an ended assignment keeps the version', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    h.cmd(id, { type: 'offer', contributorId: ANA });
    h.cmd(id, { type: 'revoke_offer' });
    const v = h.task(id).version;
    expect(h.respond(id, 'accept').ok).toBe(false);
    expect(h.task(id).version).toBe(v);
  });

  it.each([
    ['an engine match (routing → offered)', (hh: Harness, id: number) => hh.deliver(id, 1, { kind: 'match', contributorId: ANA })],
    ['an engine no-match (routing → needs_attention)', (hh: Harness, id: number) => hh.deliver(id, 1, { kind: 'no_match' })],
  ])('a real status change bumps it: %s', (_label, act) => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    const v = h.task(id).version;
    act(h, id);
    expect(h.task(id).version).toBeGreaterThan(v);
  });
});

// ── Contributor actions × assignment states ─────────────────────────────────

type ActionOutcome =
  | { ok: true; assignment: AssignmentStatus; task: TaskStatus; attention: AttentionReason | null; events: string[] }
  | { ok: false; code: 'invalid_action' };

/** PLAN §3.5 AS-02…AS-10. Actions on an ACTIVE assignment that don't fit its status are refused. */
const ACTIVE_TABLE: Record<'offered' | 'accepted' | 'in_progress', Record<ContributorAction, ActionOutcome>> = {
  offered: {
    accept: { ok: true, assignment: 'accepted', task: 'assigned', attention: null, events: ['offer_accepted'] },
    decline: { ok: true, assignment: 'declined', task: 'needs_attention', attention: 'declined', events: ['offer_declined'] },
    start: { ok: false, code: 'invalid_action' },
    withdraw: { ok: false, code: 'invalid_action' },
    complete: { ok: false, code: 'invalid_action' },
  },
  accepted: {
    accept: { ok: false, code: 'invalid_action' },
    decline: { ok: false, code: 'invalid_action' },
    start: { ok: true, assignment: 'in_progress', task: 'in_progress', attention: null, events: ['work_started'] },
    withdraw: { ok: true, assignment: 'withdrawn', task: 'needs_attention', attention: 'failed_before_start', events: ['assignment_withdrawn'] },
    complete: { ok: false, code: 'invalid_action' },
  },
  in_progress: {
    accept: { ok: false, code: 'invalid_action' },
    decline: { ok: false, code: 'invalid_action' },
    start: { ok: false, code: 'invalid_action' },
    withdraw: { ok: false, code: 'invalid_action' },
    complete: { ok: true, assignment: 'completed', task: 'completed', attention: null, events: ['work_completed'] },
  },
};

const ACTION_PAIRS = ASSIGNMENT_STATES.flatMap((s) =>
  CONTRIBUTOR_ACTIONS.map((action) => {
    const active = ACTIVE_ASSIGNMENT_STATUSES.includes(s.status);
    const out = active ? ACTIVE_TABLE[s.status as keyof typeof ACTIVE_TABLE][action] : null;
    const name = !active
      ? `${s.status} assignment + ${action} → refused as no longer active, recorded once as late_response_ignored, nothing else changes`
      : out!.ok
        ? `${s.status} assignment + ${action} → assignment ${out!.assignment}, task ${out!.task}${out!.attention ? ` (${out!.attention})` : ''}`
        : `${s.status} assignment + ${action} → refused as invalid for the assignment's status; nothing changes, recorded once as late_response_ignored (PLAN TT-22)`;
    return { name, s, action, active, out };
  }),
);

describe('contributor actions × assignment states', () => {
  it.each(named(ACTION_PAIRS))('%s', (_name, { s, action, active, out }) => {
    h = createHarness({ world: 'spy' });
    const { taskId, assignmentId } = s.reach(h);
    expect(h.repo.getAssignment(assignmentId)!.status).toBe(s.status);
    const taskBefore = h.task(taskId);
    const asgBefore = h.repo.getAssignment(assignmentId)!;
    const eventsBefore = h.types(taskId).length;
    const globalBefore = h.repo.eventCount();

    const r = h.app.desk.respond(assignmentId, action, { note: 'from the matrix' });
    h.assertInvariants();

    if (!active) {
      expect(r).toEqual({ ok: false, code: 'assignment_not_active', message: expect.any(String) });
      expect(newEventTypes(h, taskId, eventsBefore)).toEqual(['late_response_ignored']);
      expect(h.repo.eventCount()).toBe(globalBefore + 1);
      expect(h.task(taskId)).toEqual(taskBefore);
      expect(h.repo.getAssignment(assignmentId)).toEqual(asgBefore);
      const ghost = h.repo.eventsForTask(taskId).at(-1)!;
      expect(ghost).toMatchObject({ actor: 'contributor', assignmentId, contributorId: ANA });
      expect(ghost.payload).toMatchObject({ action, assignmentStatus: s.status });
      return;
    }
    if (!out!.ok) {
      expect(r).toMatchObject({ ok: false, code: 'invalid_action' });
      expect(newEventTypes(h, taskId, eventsBefore)).toEqual(['late_response_ignored']);
      expect(h.repo.eventCount()).toBe(globalBefore + 1);
      expect(h.task(taskId)).toEqual(taskBefore);
      expect(h.repo.getAssignment(assignmentId)).toEqual(asgBefore);
      const ghost = h.repo.eventsForTask(taskId).at(-1)!;
      expect(ghost).toMatchObject({ actor: 'contributor', assignmentId });
      expect(ghost.payload).toMatchObject({ action, assignmentStatus: s.status });
      expect(ghost.summary).toMatch(/Not applied\.$/);
      return;
    }
    expect(r).toEqual({ ok: true });
    expect(h.repo.getAssignment(assignmentId)!.status).toBe(out!.assignment);
    expect(h.task(taskId).status).toBe(out!.task);
    expect(h.task(taskId).attentionReason).toBe(out!.attention);
    expect(newEventTypes(h, taskId, eventsBefore)).toEqual(out!.events);
    expect(h.task(taskId).version).toBeGreaterThan(taskBefore.version);
  });

  it.each(named(ACTION_PAIRS.filter((p) => !p.active || !p.out!.ok)))('HTTP: %s → 409 with the current task', async (_name, { s, action }) => {
    h = createHarness({ world: 'spy' });
    const { taskId, assignmentId } = s.reach(h);
    const res = await h.http.post(`/api/sim/assignments/${assignmentId}/respond`).send({ action });
    expect(res.status).toBe(409);
    expect(ApiErrorDto.safeParse(res.body).success).toBe(true);
    expect(res.body.error.code).toBe(ACTIVE_ASSIGNMENT_STATUSES.includes(s.status) ? 'invalid_action' : 'assignment_not_active');
    expect(res.body.error.task.id).toBe(taskId);
  });

  it('the late-response history line says why the reply was ignored, for every way an assignment can end', () => {
    const why: Record<string, RegExp> = {
      completed: /already completed/,
      declined: /already declined/,
      expired: /offer had expired/,
      revoked: /offer had been revoked/,
      withdrawn: /already withdrawn/,
      released: /released from the task/,
      cancelled: /task had been cancelled/,
    };
    for (const s of ASSIGNMENT_STATES.filter((x) => !ACTIVE_ASSIGNMENT_STATUSES.includes(x.status))) {
      h = createHarness({ world: 'spy' });
      const { taskId, assignmentId } = s.reach(h);
      h.app.desk.respond(assignmentId, 'accept');
      expect(h.repo.eventsForTask(taskId).at(-1)!.summary, s.status).toMatch(why[s.status]);
      h.close();
    }
  });
});

describe('the database itself enforces R1 and R2; the invariant checker catches R10', () => {
  it('R1: a second active assignment for the same task is rejected by the partial unique index', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ submit: false });
    h.cmd(id, { type: 'offer', contributorId: ANA });
    const now = h.clock.now();
    expect(() => h.sql.tx(() => h.repo.insertOffer({ taskId: id, contributorId: BEN, source: 'operator', attemptId: null, offeredAt: now, expiresAt: now + 1, note: null }))).toThrow(/UNIQUE/);
    expect(h.repo.assignmentsForTask(id)).toHaveLength(1);
  });

  it('R2: a second pending request for the same task is rejected by the partial unique index', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    const now = h.clock.now();
    expect(() => h.sql.tx(() => h.repo.insertAttempt({ taskId: id, round: 1, seq: 2, retryIndex: 1, candidates: [], excluded: [], dispatchedAt: now, deadlineAt: now + 1 }))).toThrow(/UNIQUE/);
    expect(h.attempts(id)).toHaveLength(1);
  });

  it('R10: a pending request next to an active assignment is reported by the checker the harness runs after every step', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create();
    const now = h.clock.now();
    // Simulated corruption, written behind the desk's back: the checker must notice.
    h.sql.tx(() => h.repo.insertOffer({ taskId: id, contributorId: BEN, source: 'operator', attemptId: null, offeredAt: now, expiresAt: now + 1_000, note: null }));
    const rules = checkInvariants(h.sql).map((v) => v.rule);
    expect(rules.some((r) => r.startsWith('I5'))).toBe(true);
    expect(() => h.assertInvariants()).toThrow(/I5 never a pending request and an active assignment together/);
    expect(() => h.advance(500)).toThrow(/Invariant violated/);
  });
});
