// The pages and an optional open task, all in the URL, so a refresh or a shared link keeps context.
// Small enough that a router library would cost more than it saves.
import { useCallback, useEffect, useSyncExternalStore } from 'react';

export type Page = 'tasks' | 'activity' | 'contributors' | 'how-it-works';

const PATH: Record<Page, string> = { tasks: '/', activity: '/activity', contributors: '/contributors', 'how-it-works': '/how-it-works' };
const CHANGE = 'desk:navigate';

/** Unknown paths fall back to the task list. Exported for tests. */
export function pageOf(pathname: string): Page {
  const hit = (Object.keys(PATH) as Page[]).find((p) => PATH[p] === pathname.replace(/\/+$/, '') && p !== 'tasks');
  return hit ?? 'tasks';
}

/** The path the address bar should show for `pathname`: unknown paths become `/` (they show the task list). */
export function canonicalPath(pathname: string): string {
  return PATH[pageOf(pathname)];
}

/** `?task=T-104` (or `104`) → 104; anything else → null. Digits only, so `T-1e3` or `0x10` never opens a task. Exported for tests. */
export function taskOf(search: string): number | null {
  const v = new URLSearchParams(search).get('task');
  const m = v ? /^(?:T-)?([1-9]\d{0,9})$/i.exec(v) : null;
  return m ? Number(m[1]) : null;
}

const subscribe = (cb: () => void) => {
  window.addEventListener('popstate', cb);
  window.addEventListener(CHANGE, cb);
  return () => {
    window.removeEventListener('popstate', cb);
    window.removeEventListener(CHANGE, cb);
  };
};
const read = () => window.location.pathname + window.location.search;

export function useRoute() {
  const href = useSyncExternalStore(subscribe, read);
  const url = new URL(href, window.location.origin);
  const page = pageOf(url.pathname);
  const taskId = taskOf(url.search);

  // A mistyped or stale path shows the task list; make the address bar say so (keeping ?task=).
  const canonical = canonicalPath(url.pathname);
  useEffect(() => {
    if (window.location.pathname !== canonical) {
      const u = new URL(window.location.href);
      u.pathname = canonical;
      window.history.replaceState(null, '', u);
      window.dispatchEvent(new Event(CHANGE));
    }
  }, [canonical, href]);

  const go = useCallback((next: Page) => {
    const u = new URL(window.location.href);
    u.pathname = PATH[next];
    window.history.pushState(null, '', u);
    window.dispatchEvent(new Event(CHANGE));
  }, []);

  /** Opening a task keeps the current page underneath; it doesn't add a history entry per click. */
  const openTask = useCallback((id: number | null) => {
    const u = new URL(window.location.href);
    if (id) u.searchParams.set('task', `T-${id}`);
    else u.searchParams.delete('task');
    window.history.replaceState(null, '', u);
    window.dispatchEvent(new Event(CHANGE));
  }, []);

  return { page, taskId, go, openTask };
}
