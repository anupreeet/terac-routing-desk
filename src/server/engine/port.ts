// The desk's view of the outside world. The desk depends only on these interfaces; the simulator
// (src/server/sim) implements them, and a real engine would too.
import type { Priority } from '../../shared/policy';
import type { CandidateSnap } from '../store/repo';

export interface DispatchRequest {
  attemptId: number;
  taskId: number;
  seq: number;
  expertiseId: string;
  expertiseLabel: string;
  priority: Priority;
  candidates: CandidateSnap[];
  dispatchedAt: number;
}

/**
 * Called INSIDE the dispatch transaction. Must be synchronous and must not throw.
 * The answer (or silence) comes back later through `desk.applyEngineResult`, exactly as a
 * webhook from a real engine would.
 */
export interface RoutingEngine {
  dispatch(req: DispatchRequest): void;
}

export interface OfferNotice {
  assignmentId: number;
  taskId: number;
  contributorId: number;
  offeredAt: number;
  expiresAt: number;
}

/** "Notify the contributor." Called inside the offer transaction. Replies come back via `desk.respond`. */
export interface ContributorChannel {
  offerCreated(o: OfferNotice): void;
}

export type EngineResult =
  | { kind: 'match'; contributorId: number; reason?: string | null; simulatedBy?: string }
  | { kind: 'no_match'; reason?: string | null; simulatedBy?: string };

/** Records requests and never answers. Used by tests that drive answers by hand, and by the seed. */
export class SpyEngine implements RoutingEngine {
  readonly requests: DispatchRequest[] = [];
  dispatch(req: DispatchRequest): void {
    this.requests.push(structuredClone(req));
  }
}

export class SpyChannel implements ContributorChannel {
  readonly offers: OfferNotice[] = [];
  offerCreated(o: OfferNotice): void {
    this.offers.push({ ...o });
  }
}
