// Duration and time formatting shared by server-written summaries and the UI.

/** 40000 → "40.0s" (one decimal; used for latencies). */
export function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 72000 → "1m 12s", 8000 → "8s", 3_725_000 → "1h 2m". Never negative. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Countdown "0:24", "1:05". Clamped at 0:00. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Wall-clock "14:31:02" in local time. */
export function clockTime(epochMs: number): string {
  const d = new Date(epochMs);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

export function taskRef(id: number): string {
  return `T-${id}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Length as people (and SQLite's length()) count it: characters, not UTF-16 units. "😀" is 1. */
export function charCount(s: string): number {
  return [...s].length;
}

// Control characters, bidi overrides and invisible characters. Line breaks and tabs are fine in
// multi-line text (briefs, notes) but not in one-line fields (titles, names).
const UNSAFE_ANYWHERE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u202A-\u202E\u2066-\u2069\uFEFF]/;
const LINE_BREAKS = /[\t\n\r]/;
export function unsafeText(s: string, multiline = false): boolean {
  return UNSAFE_ANYWHERE.test(s) || (!multiline && LINE_BREAKS.test(s));
}
