// Everything the operator reads about a task's state, in one place. Copy rules: never call a
// pending request "stuck", "failed" or "lost"; past 20 s it is Overdue — a label, not a verdict.
import { isOverdue, type Policy, type Priority } from '../../shared/policy';
import type { SnapshotDto, TaskRowDto } from '../../shared/schemas';
import { countdown, duration, plural, secs, clockTime } from '../../shared/format';

export type Display =
  | 'not_routed'
  | 'routing'
  | 'overdue'
  | 'offered'
  | 'assigned'
  | 'in_progress'
  | 'done'
  | 'needs_attention'
  | 'cancelled';

export function displayOf(t: TaskRowDto, now: number, policy: Policy): Display {
  switch (t.status) {
    case 'new':
      return 'not_routed';
    case 'routing':
      return t.currentAttempt && isOverdue(t.currentAttempt.dispatchedAt, now, policy) ? 'overdue' : 'routing';
    case 'completed':
      return 'done';
    default:
      return t.status;
  }
}

export type Tone = 'red' | 'amber' | 'blue' | 'cyan' | 'green' | 'gray' | 'muted';

export const STATUS: Record<Display, { label: string; tone: Tone; meaning: string }> = {
  needs_attention: { label: 'Needs attention', tone: 'red', meaning: 'Automation has stopped. Nothing happens until you decide.' },
  overdue: { label: 'Overdue', tone: 'amber', meaning: 'No answer yet after the usual window. A label, not a verdict: it may still answer.' },
  routing: { label: 'Routing', tone: 'blue', meaning: 'Waiting for the engine to pick a contributor.' },
  offered: { label: 'Offered', tone: 'cyan', meaning: 'A contributor has been offered the task and has a limited time to reply.' },
  assigned: { label: 'Assigned', tone: 'green', meaning: 'Accepted. Routing is complete; work has not started.' },
  in_progress: { label: 'In progress', tone: 'green', meaning: 'The contributor is working on it.' },
  not_routed: { label: 'Not routed', tone: 'gray', meaning: 'Created or stopped. Nothing automatic happens until you route it.' },
  done: { label: 'Done', tone: 'muted', meaning: 'Completed by the contributor.' },
  cancelled: { label: 'Cancelled', tone: 'muted', meaning: 'Closed by the operator. Nothing more happens.' },
};

export const PRIORITY: Record<Priority, { label: string; level: 1 | 2 | 3 }> = {
  high: { label: 'High', level: 3 },
  normal: { label: 'Normal', level: 2 },
  low: { label: 'Low', level: 1 },
};

export function requestOf(t: TaskRowDto, policy: Policy): string {
  const a = t.currentAttempt;
  return a ? `request ${a.retryIndex + 1} of ${1 + policy.retriesPerRound}` : '';
}

/** One line under the badge in the queue. */
export function detailLine(t: TaskRowDto, now: number, policy: Policy, offerable?: number): string {
  const a = t.activeAssignment;
  switch (t.status) {
    case 'new':
      if (t.wasRouted) return t.lastOutcome?.status === 'revoked' ? `Offer to ${t.lastOutcome.contributorName} revoked` : 'Routing stopped by operator';
      return offerable === undefined ? 'Not routed yet' : `Not routed yet · ${offerable} can take it`;
    case 'routing': {
      const c = t.currentAttempt!;
      const waited = duration(now - c.dispatchedAt);
      return isOverdue(c.dispatchedAt, now, policy) ? `No answer ${waited} · ${requestOf(t, policy)}` : `Waiting ${waited} · ${requestOf(t, policy)}`;
    }
    case 'offered':
      return `Offered to ${a?.contributorName} ${a?.source === 'engine' ? `(engine #${a.attemptSeq})` : '(by operator)'}`;
    case 'assigned':
      return `${a?.contributorName} accepted · not started`;
    case 'in_progress':
      return `${a?.contributorName} · working ${duration(now - (a?.startedAt ?? now))}`;
    case 'needs_attention':
      return t.attention?.short ?? 'Needs your decision';
    case 'completed':
      return t.lastOutcome ? `Completed by ${t.lastOutcome.contributorName}` : 'Completed';
    case 'cancelled':
      return 'Cancelled';
  }
}

/**
 * The "Next" column: what the system will do on its own, and when. Offline, a countdown would run past a
 * deadline nobody is enforcing yet, so it shows the wall-clock time it's due instead (as the panel does).
 */
export function nextCell(t: TaskRowDto, now: number, offline = false): { text: string; tone: 'auto' | 'you' | 'none' } {
  const n = t.nextAutomaticAction;
  if (n && offline) return { text: `Due ${clockTime(n.at)}`, tone: 'auto' };
  if (n) {
    const left = n.at - now;
    const when = left <= 0 ? 'due now' : countdown(left);
    if (n.kind === 'retry_routing') return { text: left <= 0 ? 'Retrying…' : `Retry in ${when}`, tone: 'auto' };
    if (n.kind === 'escalate_routing') return { text: left <= 0 ? 'Coming to you…' : `To you in ${when}`, tone: 'auto' };
    return { text: left <= 0 ? 'Expiring…' : `Expires in ${when}`, tone: 'auto' };
  }
  if (t.status === 'needs_attention') return { text: 'Waiting on you', tone: 'you' };
  return { text: '—', tone: 'none' };
}

/** The sentence at the top of the drawer. */
export function heroSentence(t: TaskRowDto, now: number, policy: Policy): string {
  const a = t.activeAssignment;
  const w = policy.expectedWindowMs;
  switch (t.status) {
    case 'new':
      return t.wasRouted ? 'Not routed. Nothing happens until you route it or offer it to someone.' : 'Not routed yet. Nothing happens until you route it.';
    case 'routing': {
      const c = t.currentAttempt!;
      const waited = duration(now - c.dispatchedAt);
      if (isOverdue(c.dispatchedAt, now, policy)) return `No answer for ${waited}. The engine may be slow, or this request may never come back — we can't tell from here.`;
      return `Waiting for the engine (${waited}). It usually answers in ${w.min / 1000}–${w.max / 1000}s.`;
    }
    case 'offered':
      return `Offered to ${a?.contributorName} ${duration(now - (a?.offeredAt ?? now))} ago${a?.source === 'engine' ? `, chosen by request #${a.attemptSeq}` : ' by the operator'}. Waiting for a reply.`;
    case 'assigned':
      return `${a?.contributorName} accepted ${duration(now - (a?.respondedAt ?? now))} ago. Routing is complete. Work hasn't started.`;
    case 'in_progress':
      return `${a?.contributorName} started work ${duration(now - (a?.startedAt ?? now))} ago.`;
    case 'needs_attention':
      return t.attention?.detail ?? 'Needs your decision.';
    case 'completed':
      return t.lastOutcome ? `Completed by ${t.lastOutcome.contributorName}.` : 'Completed.';
    case 'cancelled':
      return 'Cancelled. Nothing more happens to this task.';
  }
}

/** "What happens next" — always present, always honest about what is and isn't automatic. */
export function whatNext(t: TaskRowDto, now: number, offline: boolean): { lead: string; rest?: string; auto: boolean } {
  const n = t.nextAutomaticAction;
  if (n) {
    const left = n.at - now;
    const at = clockTime(n.at);
    if (offline) return { lead: `Due at ${at}`, rest: 'Enforced as soon as the server is back. Deadlines are stored on the server.', auto: true };
    const when = left <= 0 ? 'now — applying…' : `in ${countdown(left)}`;
    if (n.kind === 'retry_routing') {
      return {
        lead: `Retry ${when}`,
        rest: `(at ${at}). If request #${(t.currentAttempt?.seq ?? 1)} hasn't answered by then, we stop waiting and send request ${n.nextRequest} of ${n.requestsPerRound}. You don't have to wait — offer it to someone or route again now.`,
        auto: true,
      };
    }
    if (n.kind === 'escalate_routing') {
      return { lead: `Comes to you ${when}`, rest: `(at ${at}). This is the last automatic request of the round; if it doesn't answer, we stop retrying and hand the task to you.`, auto: true };
    }
    return { lead: `Offer expires ${when}`, rest: `(at ${at}). If ${n.contributorName} doesn't reply by then, the task comes to you.`, auto: true };
  }
  switch (t.status) {
    case 'needs_attention':
      if (t.attention?.reason === 'no_eligible_contributors') {
        // No round ran: nobody could be sent to the engine, so it was never asked.
        return { lead: 'Nothing automatic. This task waits for you.', rest: 'Nobody eligible could be sent to the engine, so it wasn’t asked. Routing again only helps once someone with this expertise is free.', auto: false };
      }
      return t.attention?.reason === 'routing_exhausted' || t.attention?.reason === 'no_match'
        ? { lead: 'Nothing automatic. This task waits for you.', rest: 'Automatic routing has stopped for this round.', auto: false }
        : { lead: 'Nothing automatic. This task waits for you.', rest: "We don't re-route after a person says no or doesn't reply — their reason might change what you do next. (Engine timeouts are different: those we retry.)", auto: false };
    case 'new':
      return { lead: 'Nothing automatic.', rest: 'Route it when you’re ready, or offer it to someone directly.', auto: false };
    case 'assigned':
    case 'in_progress':
      return { lead: 'Nothing automatic.', rest: `Routing is complete — waiting on ${t.activeAssignment?.contributorName}.`, auto: false };
    default:
      return { lead: 'Nothing more will happen.', auto: false };
  }
}

export function latency(ms: number): string {
  return secs(ms);
}

/** Why someone is skipped by engine routing for a task. One vocabulary for the panel and the Offer dialog. */
export const EXCLUSION_LABEL: Record<string, string> = { declined: 'Declined', expired: 'Didn’t reply in time', withdrawn: 'Withdrew', released: 'Released by operator' };

export function exclusionText(e: { status: string; note: string | null } | null | undefined): string {
  if (!e) return '';
  return `${EXCLUSION_LABEL[e.status] ?? e.status}${e.note ? `: “${e.note}”` : ''}`;
}

export type LinePart = string | { mono: string } | { warn: string };

/**
 * The line under the Tasks headline. It only claims things are "moving on their own" when something is in
 * flight, and it counts what is waiting to be routed, so it never reads as all-clear while work is parked.
 */
export function deskLine(c: SnapshotDto['counts'], nextDeadlineAt: number | null, now: number, offline: boolean): LinePart[] {
  const inFlight = c.routing + c.offered;
  const parts: LinePart[] = [];
  if (inFlight) {
    // Offline, nothing is moving until the server is back (it then enforces whatever came due).
    parts.push(offline ? `${inFlight} in flight` : `${inFlight} in flight, moving on ${inFlight === 1 ? 'its' : 'their'} own`);
    if (nextDeadlineAt !== null) parts.push(offline ? ', next deadline due at ' : ', next deadline in ', { mono: offline ? clockTime(nextDeadlineAt) : countdown(nextDeadlineAt - now) });
    if (c.overdue) parts.push({ warn: `, ${plural(c.overdue, 'request')} overdue` });
    parts.push('.');
  } else {
    parts.push('Nothing in flight.');
  }
  if (c.notRouted) parts.push(` ${plural(c.notRouted, 'task')} not routed yet.`);
  return parts;
}
