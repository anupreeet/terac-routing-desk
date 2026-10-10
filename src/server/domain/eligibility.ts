// Who can take a task right now, and if not, why. Pure: callers pass in the facts.
import type { AssignmentStatus } from '../../shared/policy';

export type Blocker = 'no_expertise' | 'away' | 'excluded' | 'at_capacity';

export interface ContributorFacts {
  id: number;
  name: string;
  availability: 'available' | 'away';
  maxActive: number;
  load: number; // active assignments (offered + accepted + in_progress) across all tasks
  expertise: readonly string[];
}

export interface Exclusion {
  contributorId: number;
  status: AssignmentStatus; // declined | expired | withdrawn | released
  at: number | null;
  note: string | null;
}

export interface Verdict {
  contributor: ContributorFacts;
  /** First failing rule, in order: expertise → availability → excluded for this task → capacity. */
  blocker: Blocker | null;
  exclusion: Exclusion | null;
}

export function judge(c: ContributorFacts, expertiseId: string, exclusions: ReadonlyMap<number, Exclusion>): Verdict {
  const exclusion = exclusions.get(c.id) ?? null;
  let blocker: Blocker | null = null;
  if (!c.expertise.includes(expertiseId)) blocker = 'no_expertise';
  else if (c.availability !== 'available') blocker = 'away';
  else if (exclusion) blocker = 'excluded';
  else if (c.load >= c.maxActive) blocker = 'at_capacity';
  return { contributor: c, blocker, exclusion };
}

/** Everyone with the expertise, judged. People without the expertise are never listed. */
export function judgeAll(all: readonly ContributorFacts[], expertiseId: string, exclusions: ReadonlyMap<number, Exclusion>): Verdict[] {
  return all.filter((c) => c.expertise.includes(expertiseId)).map((c) => judge(c, expertiseId, exclusions));
}

export const BLOCKER_TEXT: Record<Blocker, string> = {
  no_expertise: 'does not have this expertise',
  away: 'away',
  excluded: 'excluded for this task',
  at_capacity: 'at capacity',
};

/** The same facts as a clause about the person ("…, although they declined it earlier"). */
export const EXCLUSION_CLAUSE: Partial<Record<AssignmentStatus, string>> = {
  declined: 'they declined it earlier',
  expired: 'they let an earlier offer expire',
  withdrawn: 'they withdrew earlier',
  released: 'they were released earlier',
};

export const EXCLUSION_TEXT: Partial<Record<AssignmentStatus, string>> = {
  declined: 'declined this task',
  expired: 'let an offer for this task expire',
  withdrawn: 'withdrew from this task',
  released: 'was released from this task',
};
