// Server time on the client. Ages and countdowns use the server's clock (via an offset measured
// on every snapshot), so a skewed laptop clock can't make a deadline look missed or early.
import { useEffect, useState, useSyncExternalStore } from 'react';

let offsetMs = 0;
const listeners = new Set<() => void>();

/** offset = serverNow − midpoint(sentAt, receivedAt) */
export function recordServerTime(serverNow: number, sentAt: number, receivedAt: number): void {
  const next = serverNow - (sentAt + receivedAt) / 2;
  if (Math.abs(next - offsetMs) > 250) {
    offsetMs = next;
    listeners.forEach((l) => l());
  }
}

export function serverNow(): number {
  return Date.now() + offsetMs;
}

/**
 * Re-renders every `everyMs` with the current server time, aligned to whole seconds of the server clock so
 * second-resolution countdowns step evenly. Once a second is enough: every on-screen time is in seconds,
 * and re-rendering the whole board more often costs real frame time on a big desk.
 */
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(serverNow);
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => offsetMs,
  );
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const first = setTimeout(
      () => {
        setNow(serverNow());
        interval = setInterval(() => setNow(serverNow()), everyMs);
      },
      everyMs - (serverNow() % everyMs),
    );
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [everyMs]);
  return now;
}
