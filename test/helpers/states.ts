// Drive a fresh task (or assignment) into a named state using only the desk's public commands, in
// the spy world (nothing answers unless a test says so). Ana is always the contributor involved;
// Ben (also finance, capacity 1) is left untouched so he is always free to be offered the task.
import { ANA, BEN, type Harness } from './harness';
import type { AssignmentStatus, AttentionReason, TaskStatus } from '../../src/shared/policy';

export interface TaskState {
  /** Human-readable name used in test titles. */
  name: string;
  status: TaskStatus;
  attention: AttentionReason | null;
  /** Returns the id of a task now in this state. */
  reach(h: Harness): number;
}

const routing = (h: Harness, o: Parameters<Harness['create']>[0] = {}) => h.create(o);
const engineOfferToAna = (h: Harness) => {
  const id = routing(h);
  h.deliver(id, 1, { kind: 'match', contributorId: ANA });
  return id;
};
const operatorOfferToAna = (h: Harness) => {
  const id = h.create({ submit: false });
  h.cmd(id, { type: 'offer', contributorId: ANA });
  return id;
};
const anaAccepted = (h: Harness) => {
  const id = engineOfferToAna(h);
  h.respond(id, 'accept');
  return id;
};
const anaWorking = (h: Harness) => {
  const id = anaAccepted(h);
  h.respond(id, 'start');
  return id;
};

export const TASK_STATES: TaskState[] = [
  { name: 'new (never routed)', status: 'new', attention: null, reach: (h) => h.create({ submit: false }) },
  {
    name: 'new (routing stopped)',
    status: 'new',
    attention: null,
    reach: (h) => {
      const id = routing(h);
      h.cmd(id, { type: 'stop_routing' });
      return id;
    },
  },
  {
    name: 'new (offer revoked)',
    status: 'new',
    attention: null,
    reach: (h) => {
      const id = operatorOfferToAna(h);
      h.cmd(id, { type: 'revoke_offer' });
      return id;
    },
  },
  { name: 'routing', status: 'routing', attention: null, reach: (h) => routing(h) },
  { name: 'offered (engine pick)', status: 'offered', attention: null, reach: engineOfferToAna },
  { name: 'offered (operator offer)', status: 'offered', attention: null, reach: operatorOfferToAna },
  { name: 'assigned', status: 'assigned', attention: null, reach: anaAccepted },
  { name: 'in_progress', status: 'in_progress', attention: null, reach: anaWorking },
  {
    name: 'completed',
    status: 'completed',
    attention: null,
    reach: (h) => {
      const id = anaWorking(h);
      h.respond(id, 'complete');
      return id;
    },
  },
  {
    name: 'needs_attention (no_eligible_contributors)',
    status: 'needs_attention',
    attention: 'no_eligible_contributors',
    reach: (h) => {
      // Everyone with Finance is away at submit time; they come back afterwards so recovery is possible.
      h.app.desk.setAvailability(ANA, 'away');
      h.app.desk.setAvailability(BEN, 'away');
      const id = routing(h);
      h.app.desk.setAvailability(ANA, 'available');
      h.app.desk.setAvailability(BEN, 'available');
      return id;
    },
  },
  {
    name: 'needs_attention (no_match)',
    status: 'needs_attention',
    attention: 'no_match',
    reach: (h) => {
      const id = routing(h);
      h.deliver(id, 1, { kind: 'no_match' });
      return id;
    },
  },
  {
    name: 'needs_attention (routing_exhausted)',
    status: 'needs_attention',
    attention: 'routing_exhausted',
    reach: (h) => {
      const id = routing(h, { priority: 'high' });
      h.advance(3 * h.app.policy.requestDeadlineMs.high);
      return id;
    },
  },
  {
    name: 'needs_attention (declined)',
    status: 'needs_attention',
    attention: 'declined',
    reach: (h) => {
      const id = engineOfferToAna(h);
      h.respond(id, 'decline', 'Conflict of interest');
      return id;
    },
  },
  {
    name: 'needs_attention (offer_expired)',
    status: 'needs_attention',
    attention: 'offer_expired',
    reach: (h) => {
      const id = engineOfferToAna(h);
      h.advance(h.app.policy.offerTtlMs);
      return id;
    },
  },
  {
    name: 'needs_attention (failed_before_start: withdrew)',
    status: 'needs_attention',
    attention: 'failed_before_start',
    reach: (h) => {
      const id = anaAccepted(h);
      h.respond(id, 'withdraw', 'Travelling');
      return id;
    },
  },
  {
    name: 'needs_attention (failed_before_start: released)',
    status: 'needs_attention',
    attention: 'failed_before_start',
    reach: (h) => {
      const id = anaAccepted(h);
      h.cmd(id, { type: 'release', note: 'No-show for kickoff' });
      return id;
    },
  },
  {
    name: 'cancelled',
    status: 'cancelled',
    attention: null,
    reach: (h) => {
      const id = routing(h);
      h.cmd(id, { type: 'cancel', note: 'Client paused the project' });
      return id;
    },
  },
];

export interface AssignmentState {
  status: AssignmentStatus;
  /** Returns the task and the assignment (Ana's), now in this status. */
  reach(h: Harness): { taskId: number; assignmentId: number };
}

const lastAsg = (h: Harness, taskId: number) => ({ taskId, assignmentId: h.repo.lastAssignment(taskId)!.id });

export const ASSIGNMENT_STATES: AssignmentState[] = [
  { status: 'offered', reach: (h) => lastAsg(h, operatorOfferToAna(h)) },
  { status: 'accepted', reach: (h) => lastAsg(h, anaAccepted(h)) },
  { status: 'in_progress', reach: (h) => lastAsg(h, anaWorking(h)) },
  {
    status: 'completed',
    reach: (h) => {
      const id = anaWorking(h);
      h.respond(id, 'complete');
      return lastAsg(h, id);
    },
  },
  {
    status: 'declined',
    reach: (h) => {
      const id = operatorOfferToAna(h);
      h.respond(id, 'decline');
      return lastAsg(h, id);
    },
  },
  {
    status: 'expired',
    reach: (h) => {
      const id = operatorOfferToAna(h);
      h.advance(h.app.policy.offerTtlMs);
      return lastAsg(h, id);
    },
  },
  {
    status: 'revoked',
    reach: (h) => {
      const id = operatorOfferToAna(h);
      h.cmd(id, { type: 'revoke_offer' });
      return lastAsg(h, id);
    },
  },
  {
    status: 'withdrawn',
    reach: (h) => {
      const id = anaAccepted(h);
      h.respond(id, 'withdraw');
      return lastAsg(h, id);
    },
  },
  {
    status: 'released',
    reach: (h) => {
      const id = anaAccepted(h);
      h.cmd(id, { type: 'release', note: 'No-show' });
      return lastAsg(h, id);
    },
  },
  {
    status: 'cancelled',
    reach: (h) => {
      const id = anaAccepted(h);
      h.cmd(id, { type: 'cancel', note: 'Client paused the project' });
      return lastAsg(h, id);
    },
  },
];

/** Everything a command could touch for one task, plus the global event count, as one comparable string. */
export function footprint(h: Harness, taskId: number): string {
  return JSON.stringify({
    task: h.task(taskId),
    attempts: h.attempts(taskId),
    assignments: h.repo.assignmentsForTask(taskId),
    events: h.repo.eventCount(),
  });
}

/** Event types written for a task after the given count. */
export function newEventTypes(h: Harness, taskId: number, before: number): string[] {
  return h.types(taskId).slice(before);
}

/** Table rows for it.each('%s', …): the name first (titles are not truncated), then the case itself. */
export function named<T extends { name: string }>(xs: readonly T[]): (readonly [string, T])[] {
  return xs.map((x) => [x.name, x] as const);
}
