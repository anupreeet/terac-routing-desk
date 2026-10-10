// The operator-facing copy (src/client/lib/copy.ts) is pure: it only reads shared types and policy.
// These tests pin the FACTS each line must carry (names, countdowns, request numbers) rather than
// exact sentences, plus the copy rule: a pending request is never called stuck, failed or lost.
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXCLUSION_LABEL,
  PRIORITY,
  STATUS,
  deskLine,
  detailLine,
  displayOf,
  exclusionText,
  heroSentence,
  latency,
  nextCell,
  requestOf,
  whatNext,
  type Display,
} from '../../src/client/lib/copy';
import { POLICY, TASK_STATUSES, allowedCommands, nextAutomaticAction, type AttentionReason, type Policy, type TaskStatus } from '../../src/shared/policy';
import type { TaskRowDto } from '../../src/shared/schemas';
import { clockTime, countdown, secs } from '../../src/shared/format';
import { createHarness, type Harness } from '../helpers/harness';
import { TASK_STATES, named } from '../helpers/states';

const T = Date.UTC(2026, 9, 4, 14, 0, 0);
const S = 1_000;
const FORBIDDEN = /\b(stuck|failed|lost)\b/i;

type Attempt = NonNullable<TaskRowDto['currentAttempt']>;
type Active = NonNullable<TaskRowDto['activeAssignment']>;

function row(o: Partial<TaskRowDto> = {}): TaskRowDto {
  const status = o.status ?? 'new';
  const base: TaskRowDto = {
    id: 101,
    title: 'Expert call: CFO tooling',
    expertiseId: 'finance',
    expertiseLabel: 'Finance',
    priority: 'normal',
    status,
    attention: null,
    version: 1,
    round: 0,
    createdAt: T,
    statusChangedAt: T,
    closedAt: null,
    currentAttempt: null,
    activeAssignment: null,
    lastOutcome: null,
    wasRouted: false,
    nextAutomaticAction: null,
    allowedCommands: allowedCommands(status),
  };
  const r = { ...base, ...o };
  return { ...r, nextAutomaticAction: o.nextAutomaticAction !== undefined ? o.nextAutomaticAction : nextAutomaticAction({ status: r.status, currentAttempt: r.currentAttempt, activeAssignment: r.activeAssignment }) };
}
const attempt = (o: Partial<Attempt> = {}): Attempt => ({ id: 1, seq: 1, round: 1, retryIndex: 0, dispatchedAt: T, deadlineAt: T + 45 * S, candidateCount: 2, ...o });
const active = (o: Partial<Active> = {}): Active => ({
  id: 7,
  contributorId: 2,
  contributorName: 'Marcus Chen',
  status: 'offered',
  source: 'engine',
  attemptSeq: 1,
  offeredAt: T,
  expiresAt: T + 60 * S,
  respondedAt: null,
  startedAt: null,
  ...o,
});
const routingRow = (a: Partial<Attempt> = {}) => row({ status: 'routing', round: 1, wasRouted: true, currentAttempt: attempt(a) });
const attentionRow = (reason: AttentionReason, short = `short:${reason}`, detail = `detail:${reason}`) =>
  row({ status: 'needs_attention', wasRouted: true, attention: { reason, title: `title:${reason}`, short, detail } });

/** Every piece of text the copy module would put on screen for this row. */
function allText(t: TaskRowDto, now: number, policy: Policy = POLICY): string[] {
  const d = displayOf(t, now, policy);
  const online = whatNext(t, now, false);
  const offline = whatNext(t, now, true);
  return [
    STATUS[d].label,
    STATUS[d].meaning,
    detailLine(t, now, policy),
    detailLine(t, now, policy, 2),
    nextCell(t, now).text,
    heroSentence(t, now, policy),
    online.lead,
    online.rest ?? '',
    offline.lead,
    offline.rest ?? '',
    requestOf(t, policy),
  ];
}

describe('displayOf: status → what the badge says', () => {
  it.each([
    ['new', 'not_routed'],
    ['offered', 'offered'],
    ['assigned', 'assigned'],
    ['in_progress', 'in_progress'],
    ['completed', 'done'],
    ['needs_attention', 'needs_attention'],
    ['cancelled', 'cancelled'],
  ] as [TaskStatus, Display][])('%s → %s', (status, display) => {
    expect(displayOf(row({ status }), T, POLICY)).toBe(display);
  });

  it.each([
    [0, 'routing'],
    [POLICY.overdueAfterMs - 1, 'routing'],
    [POLICY.overdueAfterMs, 'overdue'],
    [POLICY.requestDeadlineMs.low - 1, 'overdue'],
  ])('routing, %i ms after dispatch → %s', (elapsed, display) => {
    expect(displayOf(routingRow(), T + elapsed, POLICY)).toBe(display);
  });

  it('Overdue depends only on elapsed time, never on priority', () => {
    for (const priority of ['high', 'normal', 'low'] as const) {
      expect(displayOf({ ...routingRow(), priority }, T + POLICY.overdueAfterMs, POLICY)).toBe('overdue');
    }
  });

  it('uses the policy it is given', () => {
    expect(displayOf(routingRow(), T + 5 * S, { ...POLICY, overdueAfterMs: 5 * S })).toBe('overdue');
  });

  it('a routing row without a current request is shown as routing, not overdue', () => {
    expect(displayOf(row({ status: 'routing' }), T + 99 * S, POLICY)).toBe('routing');
  });
});

describe('STATUS and PRIORITY vocabularies', () => {
  const displays: Display[] = ['not_routed', 'routing', 'overdue', 'offered', 'assigned', 'in_progress', 'done', 'needs_attention', 'cancelled'];

  it.each(displays)('%s has a label, a tone and a meaning', (d) => {
    expect(STATUS[d].label.trim()).not.toBe('');
    expect(STATUS[d].tone).toBeTruthy();
    expect(STATUS[d].meaning.trim()).not.toBe('');
  });

  it('the UI says "Not routed" for new and "Overdue" past 20 s', () => {
    expect(STATUS.not_routed.label).toBe('Not routed');
    expect(STATUS.overdue.label).toBe('Overdue');
  });

  it('red means "needs you" and nothing else; Overdue is amber', () => {
    expect(displays.filter((d) => STATUS[d].tone === 'red')).toEqual(['needs_attention']);
    expect(STATUS.overdue.tone).toBe('amber');
  });

  it('Overdue is explained as a label, not a verdict: it may still answer', () => {
    expect(STATUS.overdue.meaning).toMatch(/may still answer/i);
  });

  it('priorities rank high > normal > low', () => {
    expect(PRIORITY.high.level).toBeGreaterThan(PRIORITY.normal.level);
    expect(PRIORITY.normal.level).toBeGreaterThan(PRIORITY.low.level);
    expect([PRIORITY.high.label, PRIORITY.normal.label, PRIORITY.low.label]).toEqual(['High', 'Normal', 'Low']);
  });
});

describe('requestOf', () => {
  it.each([
    [0, 'request 1 of 3'],
    [1, 'request 2 of 3'],
    [2, 'request 3 of 3'],
  ])('retry index %i → %s', (retryIndex, text) => {
    expect(requestOf(routingRow({ retryIndex }), POLICY)).toBe(text);
  });
  it('is empty when nothing is pending', () => {
    expect(requestOf(row(), POLICY)).toBe('');
  });
  it('follows the retry budget in the policy', () => {
    expect(requestOf(routingRow(), { ...POLICY, retriesPerRound: 0 })).toBe('request 1 of 1');
  });
});

describe('detailLine: the queue line under the badge', () => {
  it('never routed: says so, and how many could take it when known', () => {
    expect(detailLine(row(), T, POLICY)).toMatch(/not routed/i);
    expect(detailLine(row(), T, POLICY, 3)).toMatch(/3/);
  });
  it('stopped by the operator', () => {
    expect(detailLine(row({ wasRouted: true, round: 1 }), T, POLICY)).toMatch(/stopped/i);
  });
  it('offer revoked names the contributor', () => {
    const t = row({ wasRouted: true, lastOutcome: { contributorName: 'Marcus Chen', status: 'revoked', note: null, endedAt: T } });
    expect(detailLine(t, T, POLICY)).toMatch(/Marcus Chen/);
    expect(detailLine(t, T, POLICY)).toMatch(/revoked/i);
  });
  it('routing shows how long we have waited and which request of the round this is', () => {
    const line = detailLine(routingRow(), T + 8 * S, POLICY);
    expect(line).toContain('8s');
    expect(line).toContain('request 1 of 3');
  });
  it('overdue says "no answer" (not a verdict) with the wait and the request number', () => {
    const line = detailLine(routingRow({ retryIndex: 1, seq: 2 }), T + 27 * S, POLICY);
    expect(line).toContain('27s');
    expect(line).toContain('request 2 of 3');
    expect(line).toMatch(/no answer/i);
  });
  it('offered says who and how: the engine request number or the operator', () => {
    const engine = detailLine(row({ status: 'offered', activeAssignment: active({ attemptSeq: 2 }) }), T, POLICY);
    expect(engine).toContain('Marcus Chen');
    expect(engine).toContain('#2');
    const op = detailLine(row({ status: 'offered', activeAssignment: active({ source: 'operator', attemptSeq: null }) }), T, POLICY);
    expect(op).toContain('Marcus Chen');
    expect(op).toMatch(/operator/i);
  });
  it('assigned and in progress name the contributor; in progress shows how long they have worked', () => {
    expect(detailLine(row({ status: 'assigned', activeAssignment: active({ status: 'accepted', respondedAt: T }) }), T, POLICY)).toContain('Marcus Chen');
    const working = detailLine(row({ status: 'in_progress', activeAssignment: active({ status: 'in_progress', startedAt: T }) }), T + 3 * 60 * S, POLICY);
    expect(working).toContain('Marcus Chen');
    expect(working).toContain('3m');
  });
  it('needs attention shows the reason line, with a fallback', () => {
    expect(detailLine(attentionRow('declined', 'Marcus Chen declined'), T, POLICY)).toBe('Marcus Chen declined');
    expect(detailLine(row({ status: 'needs_attention' }), T, POLICY).trim()).not.toBe('');
  });
  it('completed names who did it; cancelled says cancelled', () => {
    expect(detailLine(row({ status: 'completed', lastOutcome: { contributorName: 'Marcus Chen', status: 'completed', note: null, endedAt: T } }), T, POLICY)).toContain('Marcus Chen');
    expect(detailLine(row({ status: 'completed' }), T, POLICY)).toMatch(/completed/i);
    expect(detailLine(row({ status: 'cancelled' }), T, POLICY)).toMatch(/cancelled/i);
  });
});

describe('nextCell: what the system does next, and when', () => {
  it('retry: a countdown to the deadline, automatic', () => {
    const t = routingRow({ deadlineAt: T + 45 * S });
    expect(nextCell(t, T + 35 * S)).toEqual({ text: expect.stringContaining(countdown(10 * S)), tone: 'auto' });
    expect(nextCell(t, T + 35 * S).text).toMatch(/retry/i);
  });
  it('last request: a countdown to handing the task over', () => {
    const t = routingRow({ retryIndex: 2, seq: 3, deadlineAt: T + 30 * S });
    const c = nextCell(t, T + 6 * S);
    expect(c.tone).toBe('auto');
    expect(c.text).toContain(countdown(24 * S));
    expect(c.text).toMatch(/you/i);
  });
  it('offered: a countdown to expiry', () => {
    const c = nextCell(row({ status: 'offered', activeAssignment: active({ expiresAt: T + 60 * S }) }), T + 19 * S);
    expect(c).toEqual({ text: expect.stringContaining('0:41'), tone: 'auto' });
  });
  it.each([
    ['retry', routingRow({ deadlineAt: T })],
    ['escalate', routingRow({ retryIndex: 2, deadlineAt: T })],
    ['expiry', row({ status: 'offered', activeAssignment: active({ expiresAt: T }) })],
  ])('%s that is due (or overdue for enforcement) never shows a countdown or a negative time', (_k, t) => {
    for (const now of [T, T + 1, T + 10 * S]) {
      const c = nextCell(t, now);
      expect(c.tone).toBe('auto');
      expect(c.text).not.toMatch(/\d:\d\d/);
      expect(c.text).not.toMatch(/-/);
    }
  });
  it('needs attention: waiting on you', () => {
    expect(nextCell(attentionRow('no_match'), T).tone).toBe('you');
    expect(nextCell(attentionRow('no_match'), T).text).toMatch(/you/i);
  });
  it.each(['new', 'assigned', 'in_progress', 'completed', 'cancelled'] as TaskStatus[])('%s: nothing scheduled', (status) => {
    expect(nextCell(row({ status }), T).tone).toBe('none');
  });
  it.each([
    ['retry', routingRow({ deadlineAt: T + 45 * S })],
    ['escalate', routingRow({ retryIndex: 2, deadlineAt: T + 45 * S })],
    ['expiry', row({ status: 'offered', activeAssignment: active({ expiresAt: T + 45 * S }) })],
  ])('offline (%s): the wall-clock time it is due, never a countdown running past an unenforced deadline', (_k, t) => {
    for (const now of [T, T + 50 * S, T + 600 * S]) {
      const c = nextCell(t, now, true);
      expect(c).toEqual({ text: `Due ${clockTime(T + 45 * S)}`, tone: 'auto' });
    }
  });
  it('offline doesn’t change a task that waits on you', () => {
    expect(nextCell(attentionRow('declined'), T, true).tone).toBe('you');
  });
});

describe('heroSentence: the sentence at the top of the drawer', () => {
  it('routing: elapsed time and the usual window from the policy', () => {
    const s = heroSentence(routingRow(), T + 8 * S, POLICY);
    expect(s).toContain('8s');
    expect(s).toContain(`${POLICY.expectedWindowMs.min / 1000}–${POLICY.expectedWindowMs.max / 1000}s`);
  });
  it("overdue: elapsed time and an honest \"we can't tell\"", () => {
    const s = heroSentence(routingRow(), T + 27 * S, POLICY);
    expect(s).toContain('27s');
    expect(s).toMatch(/can.t tell/i);
  });
  it('offered: who, how long ago, and which request chose them (or the operator)', () => {
    const e = heroSentence(row({ status: 'offered', activeAssignment: active({ attemptSeq: 2, offeredAt: T }) }), T + 18 * S, POLICY);
    expect(e).toContain('Marcus Chen');
    expect(e).toContain('18s');
    expect(e).toContain('#2');
    expect(heroSentence(row({ status: 'offered', activeAssignment: active({ source: 'operator', attemptSeq: null }) }), T, POLICY)).toMatch(/operator/i);
  });
  it('assigned: routing is complete and work has not started', () => {
    const s = heroSentence(row({ status: 'assigned', activeAssignment: active({ status: 'accepted', respondedAt: T }) }), T + 60 * S, POLICY);
    expect(s).toContain('Marcus Chen');
    expect(s).toMatch(/routing is complete/i);
  });
  it('in progress: who started and when', () => {
    expect(heroSentence(row({ status: 'in_progress', activeAssignment: active({ status: 'in_progress', startedAt: T }) }), T + 3 * 60 * S, POLICY)).toContain('Marcus Chen');
  });
  it('needs attention: the reason detail written by the server', () => {
    expect(heroSentence(attentionRow('routing_exhausted', 's', 'The detail from the server.'), T, POLICY)).toBe('The detail from the server.');
  });
  it('completed names who did it', () => {
    expect(heroSentence(row({ status: 'completed', lastOutcome: { contributorName: 'Marcus Chen', status: 'completed', note: null, endedAt: T } }), T, POLICY)).toContain('Marcus Chen');
  });
});

describe('whatNext: always present, honest about what is and is not automatic', () => {
  it('retry: countdown, the wall-clock time, and which request comes next', () => {
    const t = routingRow({ seq: 1, deadlineAt: T + 45 * S });
    const w = whatNext(t, T + 21 * S, false);
    expect(w.auto).toBe(true);
    expect(w.lead).toContain(countdown(24 * S));
    expect(w.rest).toContain(clockTime(T + 45 * S));
    expect(w.rest).toContain('#1');
    expect(w.rest).toMatch(/2 of 3/);
  });
  it('last request: says it comes to you', () => {
    const w = whatNext(routingRow({ retryIndex: 2, seq: 3, deadlineAt: T + 30 * S }), T + 6 * S, false);
    expect(w.auto).toBe(true);
    expect(w.lead).toMatch(/you/i);
    expect(w.lead).toContain(countdown(24 * S));
  });
  it('offer: names who must reply before the deadline', () => {
    const w = whatNext(row({ status: 'offered', activeAssignment: active({ expiresAt: T + 60 * S }) }), T + 19 * S, false);
    expect(w.auto).toBe(true);
    expect(w.lead).toContain('0:41');
    expect(w.rest).toContain('Marcus Chen');
  });
  it.each([
    ['retry', routingRow({ deadlineAt: T + 45 * S })],
    ['escalate', routingRow({ retryIndex: 2, deadlineAt: T + 45 * S })],
    ['expiry', row({ status: 'offered', activeAssignment: active({ expiresAt: T + 45 * S }) })],
  ])('offline (%s): shows the absolute due time and that the server enforces it when back', (_k, t) => {
    const w = whatNext(t, T + 50 * S, true);
    expect(w.auto).toBe(true);
    expect(w.lead).toContain(clockTime(T + 45 * S));
    expect(w.rest).toMatch(/server/i);
  });
  it('a due action never shows a negative countdown', () => {
    const w = whatNext(routingRow({ deadlineAt: T }), T + 3 * S, false);
    expect(w.lead).not.toMatch(/-\d|\d:\d\d/);
    expect(w.lead).toMatch(/now/i);
  });
  it.each(['no_match', 'routing_exhausted', 'no_eligible_contributors'] as AttentionReason[])('needs attention after a machine outcome (%s): nothing automatic, routing has stopped', (reason) => {
    const w = whatNext(attentionRow(reason), T, false);
    expect(w.auto).toBe(false);
    expect(w.lead).toMatch(/you/i);
  });
  it('no eligible contributors: says the engine was never asked, not that a round stopped', () => {
    const w = whatNext(attentionRow('no_eligible_contributors'), T, false);
    expect(w.rest).toMatch(/wasn’t asked/);
    expect(w.rest).not.toMatch(/round/i);
  });
  it.each(['declined', 'offer_expired', 'failed_before_start'] as AttentionReason[])('needs attention after a human outcome (%s): explains we never re-route after a person', (reason) => {
    const w = whatNext(attentionRow(reason), T, false);
    expect(w.auto).toBe(false);
    expect(w.rest).toMatch(/re-route/i);
  });
  it.each(['assigned', 'in_progress'] as TaskStatus[])('%s: nothing automatic, waiting on the named contributor', (status) => {
    const w = whatNext(row({ status, activeAssignment: active({ status: status === 'assigned' ? 'accepted' : 'in_progress' }) }), T, false);
    expect(w.auto).toBe(false);
    expect(w.rest).toContain('Marcus Chen');
  });
  it.each(['new', 'completed', 'cancelled'] as TaskStatus[])('%s: nothing automatic', (status) => {
    const w = whatNext(row({ status }), T, false);
    expect(w.auto).toBe(false);
    expect(w.lead.trim()).not.toBe('');
  });
});

describe('deskLine: the sentence under the Tasks headline', () => {
  type Counts = Parameters<typeof deskLine>[0];
  const counts = (o: Partial<Counts> = {}): Counts => ({ attention: 0, attentionHigh: 0, routing: 0, overdue: 0, offered: 0, nextOfferExpiry: null, working: 0, notRouted: 0, done: 0, cancelled: 0, ...o });
  const text = (parts: ReturnType<typeof deskLine>) => parts.map((p) => (typeof p === 'string' ? p : 'mono' in p ? p.mono : p.warn)).join('');

  it('never says things are moving on their own when nothing is in flight', () => {
    for (const c of [counts(), counts({ attention: 67 }), counts({ notRouted: 3 }), counts({ attention: 2, working: 4 })]) {
      expect(text(deskLine(c, null, T, false))).not.toMatch(/moving|on (its|their) own/i);
      expect(text(deskLine(c, null, T, false))).toMatch(/^Nothing in flight\./);
    }
  });
  it('in flight: how many, the next deadline as a countdown, and overdue requests', () => {
    const parts = deskLine(counts({ routing: 2, offered: 1, overdue: 1 }), T + 12 * S, T, false);
    expect(text(parts)).toBe(`3 in flight, moving on their own, next deadline in ${countdown(12 * S)}, 1 request overdue.`);
    expect(parts).toContainEqual({ mono: countdown(12 * S) });
    expect(parts).toContainEqual({ warn: ', 1 request overdue' });
  });
  it('one in flight reads naturally', () => {
    expect(text(deskLine(counts({ routing: 1 }), null, T, false))).toBe('1 in flight, moving on its own.');
  });
  it('offline: the next deadline as a wall-clock time, not a countdown', () => {
    const t = text(deskLine(counts({ routing: 1 }), T + 12 * S, T + 60 * S, true));
    expect(t).toContain(clockTime(T + 12 * S));
    expect(t).not.toMatch(/in \d:\d\d/);
    expect(t).not.toMatch(/on (its|their) own/); // nothing moves until the server is back
  });
  it('counts what is waiting to be routed', () => {
    expect(text(deskLine(counts({ notRouted: 1 }), null, T, false))).toBe('Nothing in flight. 1 task not routed yet.');
    expect(text(deskLine(counts({ routing: 1, notRouted: 2 }), null, T, false))).toBe('1 in flight, moving on its own. 2 tasks not routed yet.');
  });
});

describe('exclusion labels', () => {
  it('one vocabulary for every way someone is skipped, with their note quoted', () => {
    expect(EXCLUSION_LABEL.released).toBe('Released by operator');
    expect(exclusionText({ status: 'declined', note: 'Conflict of interest' })).toBe('Declined: “Conflict of interest”');
    expect(exclusionText({ status: 'expired', note: null })).toBe('Didn’t reply in time');
    expect(exclusionText(null)).toBe('');
  });
});

describe('latency', () => {
  it.each([0, 6_000, 40_000, 41_300])('%i ms is rendered like secs()', (ms) => {
    expect(latency(ms)).toBe(secs(ms));
  });
});

describe('the COPY RULE: a pending request is never called stuck, failed or lost', () => {
  const checkpoints = [0, 5 * S, 19_999, 20 * S, 27 * S, 44_999];
  it.each(checkpoints.flatMap((elapsed) => [0, 1, 2].map((retryIndex) => [elapsed, retryIndex] as const)))('%i ms after dispatch of request index %i (fixture)', (elapsed, retryIndex) => {
    const t = routingRow({ retryIndex, seq: retryIndex + 1 });
    for (const text of allText(t, T + elapsed)) expect(text).not.toMatch(FORBIDDEN);
  });

  it('the Routing and Overdue vocabulary itself is clean', () => {
    for (const d of ['routing', 'overdue'] as Display[]) {
      expect(STATUS[d].label).not.toMatch(FORBIDDEN);
      expect(STATUS[d].meaning).not.toMatch(FORBIDDEN);
    }
  });
});

describe('real rows from the server: every state renders complete copy', () => {
  let h: Harness;
  afterEach(() => h?.close());

  it.each(named(TASK_STATES))('%s', (_name, s) => {
    h = createHarness({ world: 'spy' });
    const id = s.reach(h);
    const t = h.app.views.taskRow(h.task(id));
    const now = h.clock.now();
    expect(displayOf(t, now, POLICY)).toBe(s.status === 'new' ? 'not_routed' : s.status === 'completed' ? 'done' : s.status);
    for (const text of [detailLine(t, now, POLICY), heroSentence(t, now, POLICY), whatNext(t, now, false).lead, nextCell(t, now).text]) {
      expect(text.trim()).not.toBe('');
      expect(text).not.toMatch(/undefined|null|NaN/);
    }
    if (s.attention) expect(detailLine(t, now, POLICY)).toBe(t.attention!.short);
  });

  it('a request that never answers, followed through a whole round, is never described as stuck, failed or lost', () => {
    h = createHarness({ world: 'spy' });
    const id = h.create({ priority: 'high' });
    let checked = 0;
    for (let i = 0; i < 3 * 60; i++) {
      const t = h.app.views.taskRow(h.task(id));
      if (t.status !== 'routing') break;
      for (const text of allText(t, h.clock.now())) expect(text, `at +${i / 2}s`).not.toMatch(FORBIDDEN);
      checked++;
      h.advance(500);
    }
    expect(checked).toBe(180); // 90 s of routing: three requests of 30 s each
    expect(h.task(id).attentionReason).toBe('routing_exhausted');
  });

  it('covers every task status', () => {
    expect(new Set(TASK_STATES.map((s) => s.status))).toEqual(new Set(TASK_STATUSES));
  });
});
