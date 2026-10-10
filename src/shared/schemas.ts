// The API contract, shared by server and client. Request bodies are validated on the server;
// response shapes are checked by the contract test (and can be parsed by the client in dev).
import { z } from 'zod';
import { ABANDON_REASONS, ACTORS, ASSIGNMENT_STATUSES, ATTEMPT_STATUSES, ATTENTION_REASONS, CONTRIBUTOR_ACTIONS, OPERATOR_COMMANDS, PRIORITIES, TASK_STATUSES } from './policy';
import { CONTRIBUTOR_PRESETS, ENGINE_PRESETS } from './sim-presets';
import { charCount, unsafeText } from './format';

const id = z.number().int().positive();
const ms = z.number().int();
const NO_CONTROL = 'Remove control or invisible characters';
/** One line of text: no line breaks, no control characters. Lengths count characters, as SQLite does. */
const line = (max: number) =>
  z
    .string()
    .trim()
    .refine((s) => charCount(s) <= max, `Limited to ${max} characters`)
    .refine((s) => !unsafeText(s), NO_CONTROL);
const text = (max: number) =>
  z
    .string()
    .trim()
    .refine((s) => charCount(s) <= max, `Limited to ${max} characters`)
    .refine((s) => !unsafeText(s, true), NO_CONTROL);
const note = text(280).optional();

// ── Requests ────────────────────────────────────────────────────────────────

export const CreateTaskBody = z
  .object({
    title: z
      .string()
      .trim()
      .refine((s) => charCount(s) >= 3, 'Title needs at least 3 characters')
      .refine((s) => charCount(s) <= 120, 'Title is limited to 120 characters')
      .refine((s) => !unsafeText(s), `Title: ${NO_CONTROL.toLowerCase()}`),
    brief: text(1000).optional().default(''),
    requestedBy: line(120).optional().default(''),
    expertiseId: z.string().min(1, 'Choose an expertise area').max(64, 'Unknown expertise area'),
    priority: z.enum(PRIORITIES).default('normal'),
    submit: z.boolean().default(true),
    sim: z
      .object({
        engine: z.enum(ENGINE_PRESETS.map((p) => p.id) as [string, ...string[]]).default('realistic'),
        contributor: z.enum(CONTRIBUTOR_PRESETS.map((p) => p.id) as [string, ...string[]]).default('manual'),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CreateTaskBody = z.input<typeof CreateTaskBody>;

const commandBase = { expectedVersion: z.number().int().nonnegative(), seenEventId: z.number().int().nonnegative().optional(), note };

export const CommandBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('submit'), ...commandBase }).strict(),
  z.object({ type: z.literal('offer'), contributorId: id, acknowledgeExclusion: z.boolean().optional(), ...commandBase }).strict(),
  z.object({ type: z.literal('reroute'), ...commandBase }).strict(),
  z.object({ type: z.literal('stop_routing'), ...commandBase }).strict(),
  z.object({ type: z.literal('revoke_offer'), ...commandBase }).strict(),
  z.object({ type: z.literal('release'), ...commandBase, note: text(280).refine((s) => s.length > 0, 'Say why you are releasing this assignment') }).strict(),
  z.object({ type: z.literal('cancel'), ...commandBase }).strict(),
]);
export type CommandBody = z.input<typeof CommandBody>;
/** Omit that distributes over a union, so each command keeps its own fields. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type ParsedCommand = z.output<typeof CommandBody>;

export const RespondBody = z.object({ action: z.enum(CONTRIBUTOR_ACTIONS), note }).strict();
export type RespondBody = z.input<typeof RespondBody>;

export const DeliverBody = z
  .object({ outcome: z.enum(['match', 'no_match']), contributorId: id.optional() })
  .strict()
  .refine((b) => b.outcome === 'no_match' || b.contributorId !== undefined, { message: 'A match needs a contributor', path: ['contributorId'] });
export type DeliverBody = z.input<typeof DeliverBody>;

export const AvailabilityBody = z.object({ availability: z.enum(['available', 'away']) }).strict();

// ── Responses ───────────────────────────────────────────────────────────────

export const EventDto = z.object({
  id,
  at: ms,
  taskId: id.nullable(),
  attemptId: id.nullable(),
  assignmentId: id.nullable(),
  contributorId: id.nullable(),
  type: z.string(),
  actor: z.enum(ACTORS),
  summary: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type EventDto = z.infer<typeof EventDto>;

export const NextActionDto = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('retry_routing'), at: ms, nextRequest: z.number(), requestsPerRound: z.number() }),
    z.object({ kind: z.literal('escalate_routing'), at: ms, requestsPerRound: z.number() }),
    z.object({ kind: z.literal('expire_offer'), at: ms, contributorName: z.string() }),
  ])
  .nullable();

export const CurrentAttemptDto = z.object({ id, seq: z.number().int(), round: z.number().int(), retryIndex: z.number().int(), dispatchedAt: ms, deadlineAt: ms, candidateCount: z.number().int() });

export const ActiveAssignmentDto = z.object({
  id,
  contributorId: id,
  contributorName: z.string(),
  status: z.enum(ASSIGNMENT_STATUSES),
  source: z.enum(['engine', 'operator']),
  attemptSeq: z.number().int().nullable(),
  offeredAt: ms,
  expiresAt: ms,
  respondedAt: ms.nullable(),
  startedAt: ms.nullable(),
});

export const AttentionDto = z.object({ reason: z.enum(ATTENTION_REASONS), title: z.string(), short: z.string(), detail: z.string() });

export const LastOutcomeDto = z.object({ contributorName: z.string(), status: z.enum(ASSIGNMENT_STATUSES), note: z.string().nullable(), endedAt: ms.nullable() });

export const TaskRowDto = z.object({
  id,
  title: z.string(),
  expertiseId: z.string(),
  expertiseLabel: z.string(),
  priority: z.enum(PRIORITIES),
  status: z.enum(TASK_STATUSES),
  attention: AttentionDto.nullable(),
  version: z.number().int(),
  round: z.number().int(),
  createdAt: ms,
  statusChangedAt: ms,
  closedAt: ms.nullable(),
  currentAttempt: CurrentAttemptDto.nullable(),
  activeAssignment: ActiveAssignmentDto.nullable(),
  lastOutcome: LastOutcomeDto.nullable(),
  wasRouted: z.boolean(),
  nextAutomaticAction: NextActionDto,
  allowedCommands: z.array(z.enum(OPERATOR_COMMANDS)),
});
export type TaskRowDto = z.infer<typeof TaskRowDto>;

export const AttemptDto = z.object({
  id,
  seq: z.number().int(),
  round: z.number().int(),
  retryIndex: z.number().int(),
  status: z.enum(ATTEMPT_STATUSES),
  abandonReason: z.enum(ABANDON_REASONS).nullable(),
  candidates: z.array(z.object({ contributorId: id, name: z.string(), load: z.number(), maxActive: z.number() })),
  excluded: z.array(z.object({ contributorId: id, name: z.string(), reason: z.string() })),
  dispatchedAt: ms,
  deadlineAt: ms,
  closedAt: ms.nullable(),
  result: z
    .object({ kind: z.enum(['match', 'no_match']), contributorId: id.nullable(), contributorName: z.string().nullable(), at: ms, reason: z.string().nullable(), applied: z.boolean() })
    .nullable(),
  invalidReason: z.string().nullable(),
});
export type AttemptDto = z.infer<typeof AttemptDto>;

export const AssignmentDto = z.object({
  id,
  contributorId: id,
  contributorName: z.string(),
  source: z.enum(['engine', 'operator']),
  attemptSeq: z.number().int().nullable(),
  status: z.enum(ASSIGNMENT_STATUSES),
  offeredAt: ms,
  expiresAt: ms,
  respondedAt: ms.nullable(),
  startedAt: ms.nullable(),
  endedAt: ms.nullable(),
  note: z.string().nullable(),
});
export type AssignmentDto = z.infer<typeof AssignmentDto>;

export const CandidateDto = z.object({
  contributorId: id,
  name: z.string(),
  headline: z.string(),
  load: z.number().int(),
  maxActive: z.number().int(),
  availability: z.enum(['available', 'away']),
  /** null = can be offered now. Otherwise why not (or why it needs an acknowledgement). */
  blocker: z.enum(['away', 'at_capacity', 'excluded']).nullable(),
  exclusion: z.object({ status: z.enum(ASSIGNMENT_STATUSES), at: ms.nullable(), note: z.string().nullable() }).nullable(),
});
export type CandidateDto = z.infer<typeof CandidateDto>;

export const LateAnswerDto = z.object({
  attemptId: id,
  attemptSeq: z.number().int(),
  contributorId: id.nullable(),
  contributorName: z.string().nullable(),
  at: ms,
  offerableNow: z.boolean(),
  whyNot: z.string().nullable(),
});
export type LateAnswerDto = z.infer<typeof LateAnswerDto>;

export const TaskDetailDto = TaskRowDto.extend({
  brief: z.string(),
  requestedBy: z.string(),
  attempts: z.array(AttemptDto),
  assignments: z.array(AssignmentDto),
  events: z.array(EventDto),
  candidates: z.array(CandidateDto),
  lateAnswers: z.array(LateAnswerDto),
  /** Simulation-only affordances. Never contains a request's planned fate. */
  sim: z.object({ deliverableAttemptIds: z.array(id) }),
});
export type TaskDetailDto = z.infer<typeof TaskDetailDto>;

export const ContributorDto = z.object({
  id,
  name: z.string(),
  headline: z.string(),
  expertise: z.array(z.object({ id: z.string(), label: z.string() })),
  availability: z.enum(['available', 'away']),
  load: z.number().int(),
  maxActive: z.number().int(),
  activeTaskIds: z.array(id),
});
export type ContributorDto = z.infer<typeof ContributorDto>;

export const EngineHealthDto = z.object({
  windowMs: z.number(),
  sent: z.number().int(),
  pending: z.number().int(),
  overdue: z.number().int(),
  /** Answered before the deadline (applied, no match, or a pick that was no longer valid). */
  answered: z.number().int(),
  matched: z.number().int(),
  noMatch: z.number().int(),
  notApplied: z.number().int(),
  /** We stopped waiting at the deadline. Some of these answer later; some never do. */
  noAnswerByDeadline: z.number().int(),
  stoppedByOperator: z.number().int(),
  lateAnswers: z.number().int(),
  medianAnswerMs: z.number().nullable(),
  p90AnswerMs: z.number().nullable(),
});
export type EngineHealthDto = z.infer<typeof EngineHealthDto>;

export const ExpertiseDto = z.object({ id: z.string(), label: z.string(), contributorCount: z.number().int(), offerableCount: z.number().int() });
export type ExpertiseDto = z.infer<typeof ExpertiseDto>;

export const SnapshotDto = z.object({
  serverNow: ms,
  bootId: z.string(),
  bootedAt: ms,
  lastBoot: z.object({ at: ms, offlineMs: z.number().nullable(), summary: z.string() }).nullable(),
  policy: z.object({
    expectedWindowMs: z.object({ min: z.number(), max: z.number() }),
    overdueAfterMs: z.number(),
    requestDeadlineMs: z.object({ high: z.number(), normal: z.number(), low: z.number() }),
    retriesPerRound: z.number(),
    offerTtlMs: z.number(),
    tickMs: z.number(),
    pollMs: z.number(),
    engineHealthWindowMs: z.number(),
  }),
  counts: z.object({
    attention: z.number().int(),
    attentionHigh: z.number().int(),
    routing: z.number().int(),
    overdue: z.number().int(),
    offered: z.number().int(),
    nextOfferExpiry: ms.nullable(),
    working: z.number().int(),
    notRouted: z.number().int(),
    done: z.number().int(),
    cancelled: z.number().int(),
  }),
  /** How the engine has behaved recently. Desk facts only: it counts outcomes, never predicts one. */
  engine: EngineHealthDto,
  tasks: z.array(TaskRowDto),
  contributors: z.array(ContributorDto),
  expertise: z.array(ExpertiseDto),
});
export type SnapshotDto = z.infer<typeof SnapshotDto>;

export const ActivityQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().positive().optional() }).strict();

export const ActivityEventDto = EventDto.extend({ taskTitle: z.string().nullable() });
export type ActivityEventDto = z.infer<typeof ActivityEventDto>;

export const ActivityDto = z.object({
  events: z.array(ActivityEventDto),
  /** Pass as `before` to fetch older events; null when there are none. */
  nextBefore: z.number().int().nullable(),
});
export type ActivityDto = z.infer<typeof ActivityDto>;

export const ApiErrorDto = z.object({ error: z.object({ code: z.string(), message: z.string() }).passthrough() });
export type ApiErrorDto = z.infer<typeof ApiErrorDto>;

export const DeliverResultDto = z.object({ applied: z.boolean(), reason: z.string().nullable(), task: TaskDetailDto });
