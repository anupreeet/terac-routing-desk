// Restarting the server while work is active: a brand-new app on the same database file.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, S, T0, type Harness } from '../helpers/harness';

const open: Harness[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});

describe('restart while work is active', () => {
  it('catches up on everything that came due while down, before serving, and says so once', () => {
    const h1 = createHarness({ file: true });
    open.push(h1);
    // TC: offered at 6 s, nobody replies; offer expires at 66 s.
    const tc = h1.create({ title: 'Task C', expertiseId: 'healthcare', engine: 'quick_match', contributor: 'ignore' });
    h1.advance(8 * S);
    expect(h1.task(tc).status).toBe('offered');
    // TA: never answers; normal deadline 45 s after dispatch at 8 s → 53 s.
    const ta = h1.create({ title: 'Task A', engine: 'lost_always' });
    // TB: answers 6 s after dispatch at 8 s → 14 s.
    const tb = h1.create({ title: 'Task B', engine: 'quick_match' });
    h1.advance(2 * S); // stop at 10 s

    // Down from 10 s to 120 s. Nothing runs.
    const h2 = h1.restart(T0 + 120 * S);
    open.push(h2);

    // TB's answer reached the inbox at 14 s, before its 53 s deadline: applied. Its offer clock starts at boot.
    expect(h2.task(tb).status).toBe('offered');
    expect(h2.active(tb)!.expiresAt).toBe(T0 + 120 * S + h2.app.policy.offerTtlMs);
    // TA's request #1 timed out at 53 s (recorded at its real deadline); #2 dispatched at boot.
    const [a1, a2] = h2.attempts(ta);
    expect(a1.status).toBe('timed_out');
    expect(a1.closedAt).toBe(T0 + 53 * S);
    expect(a2.status).toBe('pending');
    expect(a2.dispatchedAt).toBe(T0 + 120 * S);
    // TC's offer expired at 66 s.
    expect(h2.task(tc).attentionReason).toBe('offer_expired');

    const restarts = h2.repo.systemEventsSince(0).filter((e) => e.type === 'desk_restarted');
    expect(restarts).toHaveLength(1);
    expect(restarts[0].summary).toMatch(/Desk restarted after ~1m 50s offline\. Caught up: 1 engine answer received, 1 request timed out, 1 offer expired\./);
    expect(h2.repo.eventsForTask(ta).find((e) => e.type === 'attempt_timed_out')!.payload.catchUp).toBe(true);
    h2.assertInvariants();

    // Booting again changes nothing except a second restart marker.
    const snapshot = { ta: h2.task(ta), tb: h2.task(tb), tc: h2.task(tc) };
    const h3 = h2.restart(T0 + 121 * S);
    open.push(h3);
    expect({ ta: h3.task(ta), tb: h3.task(tb), tc: h3.task(tc) }).toEqual(snapshot);
    expect(h3.repo.systemEventsSince(0).filter((e) => e.type === 'desk_restarted')).toHaveLength(2);
  });

  it('a request still in flight across a restart can still answer, through the same fencing', () => {
    const h1 = createHarness({ file: true });
    open.push(h1);
    const id = h1.create({ engine: 'late_answer' }); // #1 answers at 40 s
    h1.advance(10 * S);
    const h2 = h1.restart(T0 + 20 * S);
    open.push(h2);
    expect(h2.task(id).status).toBe('routing');
    h2.advance(20 * S);
    expect(h2.task(id).status).toBe('offered');
  });
});
