import type { Actor, Policy } from '../../shared/policy';
import type { ContributorChannel, RoutingEngine } from '../engine/port';
import type { Repo } from '../store/repo';
import { InvariantError } from '../domain/errors';

export interface EmitInput {
  type: string;
  actor: Actor;
  taskId: number | null;
  attemptId?: number | null;
  assignmentId?: number | null;
  contributorId?: number | null;
  summary: string;
  payload?: Record<string, unknown>;
}

/** Everything a command needs, for one transaction at one instant. */
export interface Ctx {
  repo: Repo;
  now: number;
  policy: Policy;
  engine: RoutingEngine;
  channel: ContributorChannel;
  catchUp: boolean;
  emit(e: EmitInput): number;
}

export function makeCtx(deps: { repo: Repo; policy: Policy; engine: RoutingEngine; channel: ContributorChannel; inTx: () => boolean }, now: number, catchUp: boolean): Ctx {
  return {
    repo: deps.repo,
    now,
    policy: deps.policy,
    engine: deps.engine,
    channel: deps.channel,
    catchUp,
    emit(e) {
      if (!deps.inTx()) throw new InvariantError(`event ${e.type} emitted outside a transaction`);
      const payload = { ...(e.payload ?? {}) };
      if (catchUp) payload.catchUp = true;
      return deps.repo.insertEvent({
        at: now,
        taskId: e.taskId,
        attemptId: e.attemptId ?? null,
        assignmentId: e.assignmentId ?? null,
        contributorId: e.contributorId ?? null,
        type: e.type,
        actor: e.actor,
        summary: e.summary,
        payload,
      });
    },
  };
}

/** Throw if a guarded write after a passing guard changed nothing. */
export function must(changes: number, what: string): void {
  if (changes !== 1) throw new InvariantError(`${what}: expected 1 row changed, got ${changes}`);
}

export function withNote(summary: string, note: string | null | undefined): string {
  return note ? `${summary} Note: “${note}”` : summary;
}
