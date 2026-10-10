// Boot catch-up: anything that came due while the server was down is enforced BEFORE we accept a
// single request, and the history says so.
import type { Desk } from '../commands/desk';
import type { Tick, TickReport } from './tick';
import { duration, plural } from '../../shared/format';

export interface BootResult {
  bootId: string;
  bootedAt: number;
  offlineMs: number | null;
  report: TickReport;
}

export function boot(desk: Desk, tick: Tick, now: number): BootResult {
  const { repo } = desk;
  const lastTick = repo.getMeta('last_tick_at');
  const fromEventId = repo.lastEventId();
  desk.setCatchUp(true);
  let report: TickReport;
  try {
    report = tick(now);
  } finally {
    desk.setCatchUp(false);
  }
  // Timeouts and expiries can also be enforced inline while catch-up applies a late answer or a reply,
  // so count them from the history catch-up wrote: the summary can never disagree with it.
  const caughtUp = repo.eventsAfter(fromEventId);
  report = { ...report, timedOut: caughtUp.filter((e) => e.type === 'attempt_timed_out').length, expired: caughtUp.filter((e) => e.type === 'offer_expired').length };
  const bootCount = Number(repo.getMeta('boot_count') ?? '0') + 1;
  const bootId = `${now.toString(36)}-${bootCount}`;
  const sinceLastTick = lastTick ? now - Number(lastTick) : null;
  // The clock is behind the last heartbeat (an NTP correction, a VM restored from a snapshot): downtime is
  // unknown, and deadlines already set are measured against this clock, so they can run long. Say so.
  const clockSkewMs = sinceLastTick !== null && sinceLastTick < 0 ? -sinceLastTick : 0;
  const offlineMs = sinceLastTick === null ? null : Math.max(0, sinceLastTick);

  if (offlineMs === null) {
    desk.emitSystem('desk_started', 'Desk started.', { bootId }, now);
  } else if (clockSkewMs > 0) {
    desk.emitSystem(
      'desk_restarted',
      `Desk restarted, but the system clock is ~${duration(clockSkewMs)} earlier than when the desk last ran, so the downtime is unknown. Waits already under way may run up to ~${duration(clockSkewMs)} long.`,
      { bootId, offlineMs, clockSkewMs, ...report },
      now,
    );
  } else {
    const parts = [
      report.engineAnswers && plural(report.engineAnswers, 'engine answer') + ' received',
      report.contributorResponses && plural(report.contributorResponses, 'contributor reply', 'contributor replies') + ' received',
      report.timedOut && plural(report.timedOut, 'request') + ' timed out',
      report.expired && plural(report.expired, 'offer') + ' expired',
    ].filter(Boolean);
    const caught = parts.length ? ` Caught up: ${parts.join(', ')}.` : ' Nothing came due while it was down.';
    desk.emitSystem('desk_restarted', `Desk restarted after ~${duration(offlineMs)} offline.${caught}`, { bootId, offlineMs, ...report }, now);
  }
  repo.setMeta('boot_count', String(bootCount));
  repo.setMeta('boot_id', bootId);
  repo.setMeta('booted_at', String(now));
  return { bootId, bootedAt: now, offlineMs, report };
}
