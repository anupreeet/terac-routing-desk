// The desk's rules and numbers. Server, UI copy, the policy panel and tests all read from here,
// so a number shown to the operator can never drift from the number the server enforces.

export const PRIORITIES = ['high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const TASK_STATUSES = ['new', 'routing', 'offered', 'assigned', 'in_progress', 'completed', 'needs_attention', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const FINAL_STATUSES: readonly TaskStatus[] = ['completed', 'cancelled'];

// Things that HAPPENED TO the task and stopped automation. Operator-initiated exits go back to `new`.
export const ATTENTION_REASONS = ['no_eligible_contributors', 'no_match', 'routing_exhausted', 'declined', 'offer_expired', 'failed_before_start'] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

export const ATTEMPT_STATUSES = ['pending', 'matched', 'no_match', 'invalid_result', 'timed_out', 'abandoned'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const ABANDON_REASONS = ['operator_offer', 'operator_reroute', 'operator_stop', 'task_cancelled'] as const;
export type AbandonReason = (typeof ABANDON_REASONS)[number];

export const ASSIGNMENT_STATUSES = ['offered', 'accepted', 'in_progress', 'completed', 'declined', 'expired', 'revoked', 'withdrawn', 'released', 'cancelled'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const ACTIVE_ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = ['offered', 'accepted', 'in_progress'];
/** Ending an assignment this way excludes that contributor from engine routing for the task. */
export const EXCLUDING_ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = ['declined', 'expired', 'withdrawn', 'released'];

export const OPERATOR_COMMANDS = ['submit', 'offer', 'reroute', 'stop_routing', 'revoke_offer', 'release', 'cancel'] as const;
export type OperatorCommand = (typeof OPERATOR_COMMANDS)[number];

export const CONTRIBUTOR_ACTIONS = ['accept', 'decline', 'start', 'withdraw', 'complete'] as const;
export type ContributorAction = (typeof CONTRIBUTOR_ACTIONS)[number];

export const ACTORS = ['operator', 'engine', 'system', 'contributor', 'simulator'] as const;
export type Actor = (typeof ACTORS)[number];

export interface Policy {
  expectedWindowMs: { min: number; max: number };
  overdueAfterMs: number;
  requestDeadlineMs: Record<Priority, number>;
  retriesPerRound: number;
  offerTtlMs: number;
  tickMs: number;
  pollMs: number;
  engineHealthWindowMs: number;
}

export const POLICY: Policy = {
  /** The engine's normal answer window, from the brief. */
  expectedWindowMs: { min: 5_000, max: 20_000 },
  /** Past this, a pending request is labelled Overdue. A label, not a verdict. Same for every priority. */
  overdueAfterMs: 20_000,
  /** How long we wait for one request before we stop waiting and retry. High priority waits LESS. */
  requestDeadlineMs: { high: 30_000, normal: 45_000, low: 60_000 },
  /** Automatic retries per routing round (so 3 requests per round). */
  retriesPerRound: 2,
  /** How long a contributor has to answer an offer. Compressed for the demo; hours in production. */
  offerTtlMs: 60_000,
  /** Reconciler cadence. Deadlines are also enforced before every command and at boot. */
  tickMs: 500,
  /** Client polling cadence. */
  pollMs: 1_000,
  /** The engine-health summary covers requests sent in this window. */
  engineHealthWindowMs: 24 * 60 * 60_000,
};

export function requestsPerRound(policy: Policy = POLICY): number {
  return 1 + policy.retriesPerRound;
}

export function isFinal(status: TaskStatus): boolean {
  return FINAL_STATUSES.includes(status);
}

/** The operator commands valid in each status. The server enforces this; the UI renders only these. */
export function allowedCommands(status: TaskStatus): OperatorCommand[] {
  switch (status) {
    case 'new':
      return ['submit', 'offer', 'cancel'];
    case 'routing':
      return ['offer', 'reroute', 'stop_routing', 'cancel'];
    case 'offered':
      return ['revoke_offer', 'cancel'];
    case 'assigned':
      return ['release', 'cancel'];
    case 'in_progress':
      return ['cancel'];
    case 'needs_attention':
      return ['offer', 'reroute', 'cancel'];
    case 'completed':
    case 'cancelled':
      return [];
  }
}

export function isOverdue(dispatchedAt: number, now: number, policy: Policy = POLICY): boolean {
  return now - dispatchedAt >= policy.overdueAfterMs;
}

export type NextAutomaticAction =
  | { kind: 'retry_routing'; at: number; nextRequest: number; requestsPerRound: number }
  | { kind: 'escalate_routing'; at: number; requestsPerRound: number }
  | { kind: 'expire_offer'; at: number; contributorName: string }
  | null;

/** What the system will do next on its own, and when. `null` means nothing automatic: it waits on a person. */
export function nextAutomaticAction(
  input: { status: TaskStatus; currentAttempt: { retryIndex: number; deadlineAt: number } | null; activeAssignment: { status: AssignmentStatus; expiresAt: number; contributorName: string } | null },
  policy: Policy = POLICY,
): NextAutomaticAction {
  const perRound = requestsPerRound(policy);
  if (input.status === 'routing' && input.currentAttempt) {
    const { retryIndex, deadlineAt } = input.currentAttempt;
    if (retryIndex + 1 < perRound) {
      return { kind: 'retry_routing', at: deadlineAt, nextRequest: retryIndex + 2, requestsPerRound: perRound };
    }
    return { kind: 'escalate_routing', at: deadlineAt, requestsPerRound: perRound };
  }
  if (input.status === 'offered' && input.activeAssignment?.status === 'offered') {
    return { kind: 'expire_offer', at: input.activeAssignment.expiresAt, contributorName: input.activeAssignment.contributorName };
  }
  return null;
}
