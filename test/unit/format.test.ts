// Formatting shared by server-written summaries and the UI. Every visible number goes through here,
// so the edges (zero, negatives, unit boundaries, rounding) are pinned down.
import { describe, expect, it } from 'vitest';
import { clockTime, countdown, duration, plural, secs, taskRef } from '../../src/shared/format';

const S = 1_000;
const M = 60 * S;
const H = 60 * M;

describe('secs(ms): one-decimal seconds, used for latencies', () => {
  it.each([
    [0, '0.0s'],
    [49, '0.0s'],
    [50, '0.1s'],
    [1_234, '1.2s'],
    [1_249, '1.2s'],
    [1_250, '1.3s'],
    [6_000, '6.0s'],
    [40_000, '40.0s'],
    [59_949, '59.9s'],
    [59_950, '60.0s'],
    [999_999, '1000.0s'],
  ])('%i ms → %s', (ms, text) => {
    expect(secs(ms)).toBe(text);
  });

  it('is a plain formatter: unlike duration() it does not clamp negative input', () => {
    expect(secs(-1_500)).toBe('-1.5s');
  });

  it('whole seconds end in ".0s", which server summaries strip to say "45s"', () => {
    for (const ms of [30_000, 45_000, 60_000]) expect(secs(ms).replace('.0s', 's')).toBe(`${ms / 1000}s`);
  });
});

describe('duration(ms): human ages, floored, never negative', () => {
  it.each([
    [0, '0s'],
    [999, '0s'],
    [1_000, '1s'],
    [8_000, '8s'],
    [59_999, '59s'],
    [60_000, '1m 0s'],
    [72_000, '1m 12s'],
    [3_599_999, '59m 59s'],
    [H, '1h 0m'],
    [3_725_000, '1h 2m'],
    [48 * H - 1, '47h 59m'],
    [48 * H, '2d 0h'],
    [49 * H, '2d 1h'],
    [72 * H + 61 * S, '3d 0h'],
  ])('%i ms → %s', (ms, text) => {
    expect(duration(ms)).toBe(text);
  });

  it.each([-1, -999, -60_000, -48 * H])('negative %i ms clamps to "0s" (clock skew never shows a negative age)', (ms) => {
    expect(duration(ms)).toBe('0s');
  });

  it('floors rather than rounds, so an age never runs ahead of reality', () => {
    expect(duration(59_999)).toBe('59s');
    expect(duration(M + 59_999)).toBe('1m 59s');
  });
});

describe('countdown(ms): "m:ss", rounded UP so it never shows 0:00 while time remains, clamped at 0:00', () => {
  it.each([
    [0, '0:00'],
    [1, '0:01'],
    [999, '0:01'],
    [1_000, '0:01'],
    [1_001, '0:02'],
    [24_001, '0:25'],
    [59_000, '0:59'],
    [59_001, '1:00'],
    [60_000, '1:00'],
    [65_000, '1:05'],
    [600_000, '10:00'],
    [H, '60:00'],
  ])('%i ms → %s', (ms, text) => {
    expect(countdown(ms)).toBe(text);
  });

  it.each([-0.5, -1, -1_000, -H])('a deadline already passed (%i ms) reads 0:00, never negative', (ms) => {
    expect(countdown(ms)).toBe('0:00');
  });

  it('seconds are always two digits', () => {
    for (let s = 0; s < 60; s++) expect(countdown(s * 1000)).toMatch(/^0:\d\d$/);
  });
});

describe('clockTime(epochMs): wall-clock hh:mm:ss in local time', () => {
  it.each([
    [[2026, 9, 4, 14, 31, 2], '14:31:02'],
    [[2026, 9, 4, 0, 0, 0], '00:00:00'],
    [[2026, 9, 4, 23, 59, 59], '23:59:59'],
    [[2026, 0, 1, 9, 5, 7], '09:05:07'],
  ] as const)('%j → %s', (parts, text) => {
    const [y, mo, d, hh, mm, ss] = parts;
    expect(clockTime(new Date(y, mo, d, hh, mm, ss).getTime())).toBe(text);
  });

  it('ignores milliseconds (truncates, never rounds up to the next second)', () => {
    expect(clockTime(new Date(2026, 9, 4, 14, 31, 2, 999).getTime())).toBe('14:31:02');
  });
});

describe('taskRef(id)', () => {
  it.each([
    [101, 'T-101'],
    [1, 'T-1'],
    [99_999, 'T-99999'],
  ])('%i → %s', (id, text) => {
    expect(taskRef(id)).toBe(text);
  });
});

describe('plural(n, one, many?)', () => {
  it.each([
    [0, 'request', undefined, '0 requests'],
    [1, 'request', undefined, '1 request'],
    [2, 'request', undefined, '2 requests'],
    [1, 'reply', 'replies', '1 reply'],
    [2, 'reply', 'replies', '2 replies'],
    [0, 'reply', 'replies', '0 replies'],
    [3, 'eligible Finance contributor', undefined, '3 eligible Finance contributors'],
  ])('plural(%i, %s, %s) → %s', (n, one, many, text) => {
    expect(plural(n, one, many)).toBe(text);
  });

  it('only exactly 1 is singular', () => {
    expect(plural(-1, 'offer')).toBe('-1 offers');
    expect(plural(1.5, 'offer')).toBe('1.5 offers');
  });
});
