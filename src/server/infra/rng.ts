// Deterministic randomness. A request's fate is derived from (SEED, taskId, seq), so it does not
// depend on dispatch order and a given seed replays identically.

export function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rngFor(...parts: Array<string | number>): () => number {
  return mulberry32(fnv1a32(parts.join('|')));
}

export function lerp(min: number, max: number, u: number): number {
  return Math.round(min + (max - min) * u);
}
