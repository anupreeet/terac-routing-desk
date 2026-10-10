// SIMULATION ONLY. Decides, at dispatch, what the pretend engine will do with a request.
import { lerp, rngFor } from '../infra/rng';
import type { DispatchRequest, EngineResult } from '../engine/port';
import type { EnginePreset } from '../../shared/sim-presets';
import { plural } from '../../shared/format';

/** The numbers behind "realistic". Never shown to the operator: that would be reading the answer key. */
export const SIM_PARAMS = {
  neverReturnRate: 0.2, // from the brief
  window: { min: 5_000, max: 20_000 }, // from the brief: "normally"
  slowTailRate: 0.1, // our reading of "normally": 1 in 10 answers lands in 20–90 s
  slowTail: { min: 20_000, max: 90_000 },
  noMatchRate: 0.1,
} as const;

export interface Fate {
  /** ms after dispatch; null = never answers */
  dueInMs: number | null;
  result: EngineResult;
}

export function planFate(seed: string, req: DispatchRequest, preset: EnginePreset): Fate {
  const rng = rngFor(seed, req.taskId, req.seq);
  // Always draw the same five numbers in the same order, so changing one parameter never shifts the others.
  const uFate = rng();
  const uSlow = rng();
  const uLatency = rng();
  const uNoMatch = rng();
  const uTie = rng();

  const match = (): EngineResult => pick(req, uTie);
  const noMatch = (): EngineResult => ({ kind: 'no_match', reason: `The engine judged none of the ${plural(req.candidates.length, 'candidate')} a fit.` });
  const first = req.seq === 1;

  switch (preset) {
    case 'quick_match':
      return { dueInMs: 6_000, result: match() };
    case 'late_answer':
      return { dueInMs: first ? 40_000 : 6_000, result: match() };
    case 'lost_once':
      return first ? { dueInMs: null, result: match() } : { dueInMs: 6_000, result: match() };
    case 'lost_always':
      return { dueInMs: null, result: match() };
    case 'no_match':
      return first ? { dueInMs: 8_000, result: noMatch() } : { dueInMs: 6_000, result: match() };
    case 'realistic':
    default: {
      const p = SIM_PARAMS;
      const never = uFate < p.neverReturnRate;
      const latency = uSlow < p.slowTailRate ? lerp(p.slowTail.min, p.slowTail.max, uLatency) : lerp(p.window.min, p.window.max, uLatency);
      const result = req.candidates.length === 0 || uNoMatch < p.noMatchRate ? noMatch() : match();
      return { dueInMs: never ? null : latency, result };
    }
  }
}

/** Simple and explainable: lowest load ratio wins; ties broken by a seeded draw. */
export function pick(req: DispatchRequest, uTie: number): EngineResult {
  if (req.candidates.length === 0) return { kind: 'no_match', reason: 'No candidates were sent.' };
  const ratio = (c: { load: number; maxActive: number }) => c.load / c.maxActive;
  const best = Math.min(...req.candidates.map(ratio));
  const tied = req.candidates.filter((c) => ratio(c) === best);
  const chosen = tied[Math.min(tied.length - 1, Math.floor(uTie * tied.length))];
  return {
    kind: 'match',
    contributorId: chosen.contributorId,
    reason: `Lowest current load among ${plural(req.candidates.length, `eligible ${req.expertiseLabel} contributor`)} (${chosen.name}: ${chosen.load} of ${chosen.maxActive} active).`,
  };
}
