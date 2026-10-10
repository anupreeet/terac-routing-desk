// ALL SQL against desk tables lives here. Guarded updates return the number of rows changed so
// callers can treat "0 rows after a passing guard" as the bug it is.
import type { Sql } from '../infra/db';
import type { AbandonReason, AssignmentStatus, AttemptStatus, AttentionReason, Priority, TaskStatus, Actor } from '../../shared/policy';
import { ACTIVE_ASSIGNMENT_STATUSES, EXCLUDING_ASSIGNMENT_STATUSES } from '../../shared/policy';
import type { ContributorFacts, Exclusion } from '../domain/eligibility';

const ACTIVE = ACTIVE_ASSIGNMENT_STATUSES.map((s) => `'${s}'`).join(',');
const EXCLUDING = EXCLUDING_ASSIGNMENT_STATUSES.map((s) => `'${s}'`).join(',');

// ── Row types (camelCase views of the tables) ───────────────────────────────

export interface TaskRec {
  id: number;
  title: string;
  brief: string;
  requestedBy: string;
  expertiseId: string;
  priority: Priority;
  status: TaskStatus;
  attentionReason: AttentionReason | null;
  round: number;
  currentAttemptId: number | null;
  version: number;
  createdAt: number;
  statusChangedAt: number;
  closedAt: number | null;
}

export interface CandidateSnap {
  contributorId: number;
  name: string;
  load: number;
  maxActive: number;
}
export interface ExcludedSnap {
  contributorId: number;
  name: string;
  reason: string;
}

export interface AttemptRec {
  id: number;
  taskId: number;
  round: number;
  seq: number;
  retryIndex: number;
  status: AttemptStatus;
  abandonReason: AbandonReason | null;
  candidates: CandidateSnap[];
  excluded: ExcludedSnap[];
  dispatchedAt: number;
  deadlineAt: number;
  closedAt: number | null;
  resultKind: 'match' | 'no_match' | null;
  resultContributorId: number | null;
  resultAt: number | null;
  resultReason: string | null;
  invalidReason: string | null;
}

export interface AssignmentRec {
  id: number;
  taskId: number;
  contributorId: number;
  source: 'engine' | 'operator';
  attemptId: number | null;
  status: AssignmentStatus;
  offeredAt: number;
  expiresAt: number;
  respondedAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  note: string | null;
}

export interface ContributorRec {
  id: number;
  name: string;
  headline: string;
  availability: 'available' | 'away';
  maxActive: number;
}

export interface EventRec {
  id: number;
  at: number;
  taskId: number | null;
  attemptId: number | null;
  assignmentId: number | null;
  contributorId: number | null;
  type: string;
  actor: Actor;
  summary: string;
  payload: Record<string, unknown>;
}

// ── Mappers ─────────────────────────────────────────────────────────────────

const TASK_COLS = `id, title, brief, requested_by AS requestedBy, expertise_id AS expertiseId, priority, status,
  attention_reason AS attentionReason, round, current_attempt_id AS currentAttemptId, version,
  created_at AS createdAt, status_changed_at AS statusChangedAt, closed_at AS closedAt`;

const ATTEMPT_COLS = `id, task_id AS taskId, round, seq, retry_index AS retryIndex, status, abandon_reason AS abandonReason,
  candidates_json AS candidatesJson, excluded_json AS excludedJson, dispatched_at AS dispatchedAt,
  deadline_at AS deadlineAt, closed_at AS closedAt, result_kind AS resultKind,
  result_contributor_id AS resultContributorId, result_at AS resultAt, result_reason AS resultReason,
  invalid_reason AS invalidReason`;

const ASSIGNMENT_COLS = `id, task_id AS taskId, contributor_id AS contributorId, source, attempt_id AS attemptId, status,
  offered_at AS offeredAt, expires_at AS expiresAt, responded_at AS respondedAt, started_at AS startedAt,
  ended_at AS endedAt, note`;

const EVENT_COLS = `id, at, task_id AS taskId, attempt_id AS attemptId, assignment_id AS assignmentId,
  contributor_id AS contributorId, type, actor, summary, payload_json AS payloadJson`;

function plain<T>(row: unknown): T {
  return { ...(row as object) } as T;
}

function toAttempt(row: unknown): AttemptRec {
  const r = row as AttemptRec & { candidatesJson: string; excludedJson: string };
  const { candidatesJson, excludedJson, ...rest } = r;
  return { ...rest, candidates: JSON.parse(candidatesJson), excluded: JSON.parse(excludedJson) };
}

function toEvent(row: unknown): EventRec {
  const r = row as EventRec & { payloadJson: string };
  const { payloadJson, ...rest } = r;
  return { ...rest, payload: JSON.parse(payloadJson) };
}

export function createRepo(sql: Sql) {
  return {
    // ── meta ──
    getMeta(key: string): string | null {
      return sql.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)?.value ?? null;
    },
    setMeta(key: string, value: string): void {
      sql.run(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value);
    },

    // ── expertise & contributors ──
    insertExpertise(id: string, label: string, sort: number): void {
      sql.run(`INSERT INTO expertise_areas (id, label, sort) VALUES (?, ?, ?)`, id, label, sort);
    },
    expertiseAreas(): { id: string; label: string }[] {
      return sql.all(`SELECT id, label FROM expertise_areas ORDER BY sort, label`).map((r) => plain(r));
    },
    expertiseLabel(id: string): string | null {
      return sql.get<{ label: string }>(`SELECT label FROM expertise_areas WHERE id = ?`, id)?.label ?? null;
    },
    insertContributor(c: { id?: number; name: string; headline: string; availability: 'available' | 'away'; maxActive: number; expertise: string[]; now: number }): number {
      const { lastId } = sql.run(
        `INSERT INTO contributors (id, name, headline, availability, max_active, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        c.id ?? null,
        c.name,
        c.headline,
        c.availability,
        c.maxActive,
        c.now,
      );
      for (const e of c.expertise) sql.run(`INSERT INTO contributor_expertise (contributor_id, expertise_id) VALUES (?, ?)`, lastId, e);
      return lastId;
    },
    getContributor(id: number): ContributorRec | undefined {
      const r = sql.get(`SELECT id, name, headline, availability, max_active AS maxActive FROM contributors WHERE id = ?`, id);
      return r ? plain<ContributorRec>(r) : undefined;
    },
    contributorName(id: number): string {
      return sql.get<{ name: string }>(`SELECT name FROM contributors WHERE id = ?`, id)?.name ?? `Contributor ${id}`;
    },
    setAvailability(id: number, availability: 'available' | 'away'): number {
      return sql.run(`UPDATE contributors SET availability = ? WHERE id = ? AND availability <> ?`, availability, id, availability).changes;
    },
    /** Every contributor with expertise and current active load. */
    contributorFacts(): ContributorFacts[] {
      const rows = sql.all<{ id: number; name: string; availability: 'available' | 'away'; maxActive: number; load: number; expertise: string | null }>(
        `SELECT c.id, c.name, c.availability, c.max_active AS maxActive,
           (SELECT COUNT(*) FROM assignments a WHERE a.contributor_id = c.id AND a.status IN (${ACTIVE})) AS load,
           (SELECT group_concat(expertise_id) FROM contributor_expertise ce WHERE ce.contributor_id = c.id) AS expertise
         FROM contributors c ORDER BY c.id`,
      );
      return rows.map((r) => ({ id: r.id, name: r.name, availability: r.availability, maxActive: r.maxActive, load: r.load, expertise: r.expertise ? r.expertise.split(',') : [] }));
    },
    contributorList(): (ContributorRec & { load: number; expertise: string[]; activeTaskIds: number[] })[] {
      const rows = sql.all<ContributorRec & { load: number; expertise: string | null; activeTaskIds: string | null }>(
        `SELECT c.id, c.name, c.headline, c.availability, c.max_active AS maxActive,
           (SELECT COUNT(*) FROM assignments a WHERE a.contributor_id = c.id AND a.status IN (${ACTIVE})) AS load,
           (SELECT group_concat(a.task_id) FROM assignments a WHERE a.contributor_id = c.id AND a.status IN (${ACTIVE})) AS activeTaskIds,
           (SELECT group_concat(ce.expertise_id, ',' ORDER BY e.sort) FROM contributor_expertise ce
              JOIN expertise_areas e ON e.id = ce.expertise_id WHERE ce.contributor_id = c.id) AS expertise
         FROM contributors c ORDER BY c.name`,
      );
      return rows.map((r) => ({
        ...plain<ContributorRec>(r),
        load: r.load,
        expertise: r.expertise ? r.expertise.split(',') : [],
        activeTaskIds: r.activeTaskIds ? r.activeTaskIds.split(',').map(Number) : [],
      }));
    },
    loadOf(contributorId: number): number {
      return sql.get<{ n: number }>(`SELECT COUNT(*) AS n FROM assignments WHERE contributor_id = ? AND status IN (${ACTIVE})`, contributorId)!.n;
    },

    // ── tasks ──
    insertTask(t: { title: string; brief: string; requestedBy: string; expertiseId: string; priority: Priority; now: number }): number {
      return sql.run(
        `INSERT INTO tasks (title, brief, requested_by, expertise_id, priority, status, created_at, status_changed_at)
         VALUES (?, ?, ?, ?, ?, 'new', ?, ?)`,
        t.title,
        t.brief,
        t.requestedBy,
        t.expertiseId,
        t.priority,
        t.now,
        t.now,
      ).lastId;
    },
    getTask(id: number): TaskRec | undefined {
      const r = sql.get(`SELECT ${TASK_COLS} FROM tasks WHERE id = ?`, id);
      return r ? plain<TaskRec>(r) : undefined;
    },
    listTasks(): TaskRec[] {
      return sql.all(`SELECT ${TASK_COLS} FROM tasks ORDER BY id`).map((r) => plain<TaskRec>(r));
    },
    /**
     * Compare-and-set on a task. `expect` fields must all match the current row or nothing changes.
     * Returns rows changed (0 or 1).
     */
    casTask(
      id: number,
      expect: { status?: TaskStatus; currentAttemptId?: number | null; version?: number },
      set: {
        status?: TaskStatus;
        attentionReason?: AttentionReason | null;
        currentAttemptId?: number | null;
        round?: number;
        bumpVersion?: boolean;
        statusChangedAt?: number;
        closedAt?: number | null;
      },
    ): number {
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      if (set.status !== undefined) (sets.push('status = ?'), params.push(set.status));
      if (set.attentionReason !== undefined) (sets.push('attention_reason = ?'), params.push(set.attentionReason));
      if (set.currentAttemptId !== undefined) (sets.push('current_attempt_id = ?'), params.push(set.currentAttemptId));
      if (set.round !== undefined) (sets.push('round = ?'), params.push(set.round));
      if (set.statusChangedAt !== undefined) (sets.push('status_changed_at = ?'), params.push(set.statusChangedAt));
      if (set.closedAt !== undefined) (sets.push('closed_at = ?'), params.push(set.closedAt));
      if (set.bumpVersion) sets.push('version = version + 1');
      if (!sets.length) return 0;
      const where: string[] = ['id = ?'];
      params.push(id);
      if (expect.status !== undefined) (where.push('status = ?'), params.push(expect.status));
      if (expect.version !== undefined) (where.push('version = ?'), params.push(expect.version));
      if (expect.currentAttemptId !== undefined) {
        if (expect.currentAttemptId === null) where.push('current_attempt_id IS NULL');
        else (where.push('current_attempt_id = ?'), params.push(expect.currentAttemptId));
      }
      return sql.run(`UPDATE tasks SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`, ...params).changes;
    },

    // ── routing attempts ──
    nextSeq(taskId: number): number {
      return sql.get<{ n: number }>(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM routing_attempts WHERE task_id = ?`, taskId)!.n;
    },
    attemptsInRound(taskId: number, round: number): number {
      return sql.get<{ n: number }>(`SELECT COUNT(*) AS n FROM routing_attempts WHERE task_id = ? AND round = ?`, taskId, round)!.n;
    },
    insertAttempt(a: { taskId: number; round: number; seq: number; retryIndex: number; candidates: CandidateSnap[]; excluded: ExcludedSnap[]; dispatchedAt: number; deadlineAt: number }): number {
      return sql.run(
        `INSERT INTO routing_attempts (task_id, round, seq, retry_index, status, candidates_json, excluded_json, dispatched_at, deadline_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        a.taskId,
        a.round,
        a.seq,
        a.retryIndex,
        JSON.stringify(a.candidates),
        JSON.stringify(a.excluded),
        a.dispatchedAt,
        a.deadlineAt,
      ).lastId;
    },
    getAttempt(id: number): AttemptRec | undefined {
      const r = sql.get(`SELECT ${ATTEMPT_COLS} FROM routing_attempts WHERE id = ?`, id);
      return r ? toAttempt(r) : undefined;
    },
    attemptsDispatchedSince(at: number): AttemptRec[] {
      return sql.all(`SELECT ${ATTEMPT_COLS} FROM routing_attempts WHERE dispatched_at >= ? ORDER BY id`, at).map(toAttempt);
    },
    attemptsForTask(taskId: number): AttemptRec[] {
      return sql.all(`SELECT ${ATTEMPT_COLS} FROM routing_attempts WHERE task_id = ? ORDER BY seq`, taskId).map(toAttempt);
    },
    attemptCountForTask(taskId: number): number {
      return sql.get<{ n: number }>(`SELECT COUNT(*) AS n FROM routing_attempts WHERE task_id = ?`, taskId)!.n;
    },
    /** Close a pending attempt. Guarded on status = 'pending'. */
    closeAttempt(id: number, status: Exclude<AttemptStatus, 'pending'>, closedAt: number, extra: { abandonReason?: AbandonReason; invalidReason?: string } = {}): number {
      return sql.run(
        `UPDATE routing_attempts SET status = ?, closed_at = ?, abandon_reason = ?, invalid_reason = ? WHERE id = ? AND status = 'pending'`,
        status,
        closedAt,
        extra.abandonReason ?? null,
        extra.invalidReason ?? null,
        id,
      ).changes;
    },
    /** Write the engine's answer onto the attempt exactly once, whether it is applied or not. */
    recordResultOnce(id: number, r: { kind: 'match' | 'no_match'; contributorId: number | null; reason: string | null }, at: number): number {
      return sql.run(
        `UPDATE routing_attempts SET result_kind = ?, result_contributor_id = ?, result_at = ?, result_reason = ? WHERE id = ? AND result_at IS NULL`,
        r.kind,
        r.contributorId,
        at,
        r.reason,
        id,
      ).changes;
    },
    duePendingAttemptIds(now: number): number[] {
      return sql.all<{ id: number }>(`SELECT id FROM routing_attempts WHERE status = 'pending' AND deadline_at <= ? ORDER BY deadline_at, id`, now).map((r) => r.id);
    },
    pendingAttemptCount(): number {
      return sql.get<{ n: number }>(`SELECT COUNT(*) AS n FROM routing_attempts WHERE status = 'pending'`)!.n;
    },

    // ── assignments ──
    insertOffer(a: { taskId: number; contributorId: number; source: 'engine' | 'operator'; attemptId: number | null; offeredAt: number; expiresAt: number; note: string | null }): number {
      return sql.run(
        `INSERT INTO assignments (task_id, contributor_id, source, attempt_id, status, offered_at, expires_at, note)
         VALUES (?, ?, ?, ?, 'offered', ?, ?, ?)`,
        a.taskId,
        a.contributorId,
        a.source,
        a.attemptId,
        a.offeredAt,
        a.expiresAt,
        a.note,
      ).lastId;
    },
    getAssignment(id: number): AssignmentRec | undefined {
      const r = sql.get(`SELECT ${ASSIGNMENT_COLS} FROM assignments WHERE id = ?`, id);
      return r ? plain<AssignmentRec>(r) : undefined;
    },
    activeAssignment(taskId: number): AssignmentRec | undefined {
      const r = sql.get(`SELECT ${ASSIGNMENT_COLS} FROM assignments WHERE task_id = ? AND status IN (${ACTIVE})`, taskId);
      return r ? plain<AssignmentRec>(r) : undefined;
    },
    assignmentsForTask(taskId: number): AssignmentRec[] {
      return sql.all(`SELECT ${ASSIGNMENT_COLS} FROM assignments WHERE task_id = ? ORDER BY id`, taskId).map((r) => plain<AssignmentRec>(r));
    },
    lastAssignment(taskId: number): AssignmentRec | undefined {
      const r = sql.get(`SELECT ${ASSIGNMENT_COLS} FROM assignments WHERE task_id = ? ORDER BY id DESC LIMIT 1`, taskId);
      return r ? plain<AssignmentRec>(r) : undefined;
    },
    /** Move an assignment between statuses. Guarded on the allowed `from` statuses. */
    moveAssignment(id: number, from: readonly AssignmentStatus[], to: AssignmentStatus, set: { respondedAt?: number; startedAt?: number; endedAt?: number; note?: string | null }): number {
      const sets = ['status = ?'];
      const params: (string | number | null)[] = [to];
      if (set.respondedAt !== undefined) (sets.push('responded_at = ?'), params.push(set.respondedAt));
      if (set.startedAt !== undefined) (sets.push('started_at = ?'), params.push(set.startedAt));
      if (set.endedAt !== undefined) (sets.push('ended_at = ?'), params.push(set.endedAt));
      if (set.note !== undefined) (sets.push('note = ?'), params.push(set.note));
      params.push(id);
      const inList = from.map(() => '?').join(',');
      return sql.run(`UPDATE assignments SET ${sets.join(', ')} WHERE id = ? AND status IN (${inList})`, ...params, ...from).changes;
    },
    dueOfferIds(now: number): number[] {
      return sql.all<{ id: number }>(`SELECT id FROM assignments WHERE status = 'offered' AND expires_at <= ? ORDER BY expires_at, id`, now).map((r) => r.id);
    },
    /** Contributors excluded from engine routing for this task: anyone whose assignment on it ended declined/expired/withdrawn/released. */
    exclusions(taskId: number): Map<number, Exclusion> {
      const rows = sql.all<{ contributorId: number; status: AssignmentStatus; at: number | null; note: string | null }>(
        `SELECT contributor_id AS contributorId, status, ended_at AS at, note FROM assignments
         WHERE task_id = ? AND status IN (${EXCLUDING}) ORDER BY id`,
        taskId,
      );
      const m = new Map<number, Exclusion>();
      for (const r of rows) m.set(r.contributorId, { ...r }); // latest wins
      return m;
    },

    // ── events ──
    insertEvent(e: Omit<EventRec, 'id'>): number {
      return sql.run(
        `INSERT INTO events (at, task_id, attempt_id, assignment_id, contributor_id, type, actor, summary, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        e.at,
        e.taskId,
        e.attemptId,
        e.assignmentId,
        e.contributorId,
        e.type,
        e.actor,
        e.summary,
        JSON.stringify(e.payload),
      ).lastId;
    },
    eventsForTask(taskId: number): EventRec[] {
      return sql.all(`SELECT ${EVENT_COLS} FROM events WHERE task_id = ? ORDER BY id`, taskId).map(toEvent);
    },
    /** Has this exact refused reply (same action, same assignment state) been recorded already? Uses the per-task index. */
    refusalRecorded(taskId: number, assignmentId: number, action: string, assignmentStatus: string): boolean {
      return Boolean(
        sql.get(
          `SELECT 1 AS x FROM events WHERE task_id = ? AND assignment_id = ? AND type = 'late_response_ignored'
             AND json_extract(payload_json, '$.action') = ? AND json_extract(payload_json, '$.assignmentStatus') = ? LIMIT 1`,
          taskId,
          assignmentId,
          action,
          assignmentStatus,
        ),
      );
    },
    eventsForTaskAfter(taskId: number, afterId: number): EventRec[] {
      return sql.all(`SELECT ${EVENT_COLS} FROM events WHERE task_id = ? AND id > ? ORDER BY id`, taskId, afterId).map(toEvent);
    },
    lastEventOfTypes(types: string[]): EventRec | undefined {
      const r = sql.get(`SELECT ${EVENT_COLS} FROM events WHERE type IN (${types.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`, ...types);
      return r ? toEvent(r) : undefined;
    },
    systemEventsSince(afterAt: number): EventRec[] {
      return sql.all(`SELECT ${EVENT_COLS} FROM events WHERE task_id IS NULL AND at >= ? ORDER BY id`, afterAt).map(toEvent);
    },
    /** Newest first, across the whole desk. `beforeId` pages backwards. */
    recentEvents(limit: number, beforeId?: number): EventRec[] {
      return beforeId === undefined
        ? sql.all(`SELECT ${EVENT_COLS} FROM events ORDER BY id DESC LIMIT ?`, limit).map(toEvent)
        : sql.all(`SELECT ${EVENT_COLS} FROM events WHERE id < ? ORDER BY id DESC LIMIT ?`, beforeId, limit).map(toEvent);
    },
    taskTitles(ids: number[]): Map<number, string> {
      if (!ids.length) return new Map();
      const rows = sql.all<{ id: number; title: string }>(`SELECT id, title FROM tasks WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
      return new Map(rows.map((r) => [r.id, r.title]));
    },
    lastEventId(): number {
      return sql.get<{ id: number | null }>(`SELECT MAX(id) AS id FROM events`)!.id ?? 0;
    },
    eventsAfter(afterId: number): EventRec[] {
      return sql.all(`SELECT ${EVENT_COLS} FROM events WHERE id > ? ORDER BY id`, afterId).map(toEvent);
    },
    eventCount(): number {
      return sql.get<{ n: number }>(`SELECT COUNT(*) AS n FROM events`)!.n;
    },
  };
}

export type Repo = ReturnType<typeof createRepo>;
