// One tick = deliver what the outside world has sent, then enforce every deadline that has passed.
// Runs every 500 ms, before every command, and once at boot before the server listens.
// Correctness never depends on the ticker: commands check deadlines themselves; the ticker only
// bounds how quickly the board reflects them.
import type { Desk } from '../commands/desk';
import type { Simulator } from '../sim/simulator';

export interface TickReport {
  engineAnswers: number;
  contributorResponses: number;
  timedOut: number;
  expired: number;
}

export function createTick(desk: Desk, sim: Simulator | null) {
  return function tick(now: number): TickReport {
    // Handle what came due in the order it happened, not grouped by kind: before each delivery, enforce
    // every deadline that passed before it arrived. After downtime (boot catch-up) this gives the same
    // outcome as a desk that never went down, e.g. an offer that expired first no longer counts as load
    // when a later engine pick is checked.
    const enforced = { timedOut: 0, expired: 0 };
    const enforceUpTo = (upTo: number) => {
      const r = desk.enforceDeadlines(now, upTo);
      enforced.timedOut += r.timedOut;
      enforced.expired += r.expired;
    };
    const delivered = sim ? sim.pump(now, enforceUpTo) : { engine: 0, contributor: 0 };
    enforceUpTo(now);
    desk.repo.setMeta('last_tick_at', String(now));
    return { engineAnswers: delivered.engine, contributorResponses: delivered.contributor, timedOut: enforced.timedOut, expired: enforced.expired };
  };
}

export type Tick = ReturnType<typeof createTick>;
