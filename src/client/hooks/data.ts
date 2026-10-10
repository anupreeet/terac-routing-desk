// Data hooks. The board polls the snapshot every second; the open drawer polls its task.
// Polling (rather than a socket) is deliberate: it survives server restarts with no reconnection logic.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError, isUnreachable } from '../lib/api';
import { recordServerTime, serverNow } from '../lib/clock';
import type { ActivityEventDto, CommandBody, DistributiveOmit, EventDto, TaskDetailDto } from '../../shared/schemas';
import { POLICY } from '../../shared/policy';

export function useSnapshot() {
  const q = useQuery({
    queryKey: ['snapshot'],
    queryFn: async () => {
      const r = await api.snapshot();
      recordServerTime(r.data.serverNow, r.sentAt, r.receivedAt);
      return r.data;
    },
    refetchInterval: POLICY.pollMs,
    refetchIntervalInBackground: true,
    retry: false,
    staleTime: 0,
  });

  // Offline after ~3 s without a successful poll.
  const lastOk = useRef<number>(Date.now());
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  useEffect(() => {
    if (q.isSuccess && !q.isError) {
      lastOk.current = Date.now();
      setOfflineSince(null);
    }
  }, [q.dataUpdatedAt, q.isSuccess, q.isError]);
  useEffect(() => {
    const t = setInterval(() => {
      if (Date.now() - lastOk.current > 3_000) setOfflineSince((s) => s ?? serverNow() - (Date.now() - lastOk.current));
    }, 500);
    return () => clearInterval(t);
  }, []);

  return { snapshot: q.data, error: q.error, offlineSince, loading: q.isLoading };
}

export const isNotFound = (err: unknown) => err instanceof ApiError && err.status === 404;

export function useTaskDetail(id: number | null) {
  return useQuery({
    queryKey: ['task', id],
    queryFn: () => api.task(id!),
    enabled: id !== null,
    // A task that doesn't exist won't start existing: stop asking.
    refetchInterval: (q) => (isNotFound(q.state.error) ? false : POLICY.pollMs),
    retry: false,
  });
}

/**
 * Desk-wide history, newest first. Only the newest page is polled; older pages are loaded on demand and then
 * left alone, so scrolling back through history doesn't refetch every page every few seconds, and new events
 * are added on top without pushing loaded ones out.
 */
export function useActivity(pageSize = 50) {
  const qc = useQueryClient();
  const pages = useInfiniteQuery({
    queryKey: ['activity', pageSize],
    queryFn: ({ pageParam }) => api.activity(pageSize, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const headQ = useQuery({
    queryKey: ['activity-head', pageSize],
    queryFn: () => api.activity(pageSize),
    refetchInterval: POLICY.pollMs * 2,
    retry: false,
  });
  const loaded = useMemo(() => (pages.data?.pages ?? []).flatMap((p) => p.events), [pages.data]);
  // Events newer than the loaded pages, accumulated from every poll of the newest page (newest first).
  const [fresh, setFresh] = useState<ActivityEventDto[]>([]);
  const newestLoaded = loaded[0]?.id ?? 0;
  const head = headQ.data;
  useEffect(() => {
    if (!head || !pages.data) return;
    const known = Math.max(fresh[0]?.id ?? 0, newestLoaded);
    const top = head.events[0]?.id ?? 0;
    const oldest = head.events.at(-1)?.id ?? 0;
    // The ids went backwards (the demo was reset), or more than a page happened between two polls (a gap we
    // can't see across): start again from the top rather than show a mix or a hole.
    if (top < known || (known > 0 && oldest > known + 1 && head.nextBefore !== null)) {
      setFresh([]);
      qc.resetQueries({ queryKey: ['activity', pageSize] });
      return;
    }
    const added = head.events.filter((e) => e.id > known);
    if (added.length) setFresh((f) => [...added, ...f]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head]);
  // Once the loaded pages catch up (a reset refetch), drop accumulated events they now contain.
  const events = useMemo<ActivityEventDto[]>(() => [...fresh.filter((e) => e.id > newestLoaded), ...loaded], [fresh, loaded, newestLoaded]);

  return {
    events,
    isLoading: pages.isLoading,
    hasNextPage: pages.hasNextPage,
    isFetchingNextPage: pages.isFetchingNextPage,
    fetchNextPage: () => pages.fetchNextPage(),
  };
}

export interface Conflict {
  attempted: string;
  message: string;
  unseen: EventDto[];
  at: number;
}

/**
 * Ignores a second call while the first is still in flight. A double-click is one user action, so it must be one
 * request: otherwise the second would carry a stale version and come back as a false "changed while you were looking".
 */
export function useSingleFlight() {
  const busy = useRef(false);
  return useCallback(<T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (busy.current) return Promise.resolve(undefined);
    busy.current = true;
    return fn().finally(() => {
      busy.current = false;
    });
  }, []);
}

/** What the operator was looking at when they decided: the task version and the last event they had seen. */
export interface Basis {
  expectedVersion: number;
  seenEventId: number;
}
export const basisOf = (t: TaskDetailDto): Basis => ({ expectedVersion: t.version, seenEventId: t.events.at(-1)?.id ?? 0 });

/**
 * How one command ended. `conflict`: the task changed since the basis (the panel explains what changed).
 * `unreachable`: the desk didn't answer. `refused`: the desk said no, with a reason. `ignored`: a second
 * click while the first was still in flight.
 */
export type CommandResult = { outcome: 'applied' | 'conflict' | 'ignored' } | { outcome: 'unreachable' | 'refused'; message: string };

export const UNREACHABLE_ACTION = 'Couldn’t reach the desk server, so this may not have gone through. The panel shows the current state once it reconnects.';

/** Run one operator command (always exactly one server request for one user action). */
export function useCommand(task: TaskDetailDto | undefined) {
  const qc = useQueryClient();
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (body: DistributiveOmit<CommandBody, 'expectedVersion' | 'seenEventId'> & { label: string; done?: string; basis?: Basis }) => {
      const { label: _label, done: _done, basis, ...rest } = body;
      // The basis is fixed when the operator decides (a dialog freezes it when it opens), never read at send
      // time: otherwise a change behind an open dialog would be silently overwritten instead of a conflict.
      return api.command(task!.id, { ...rest, ...(basis ?? basisOf(task!)) } as CommandBody);
    },
    onMutate: () => {
      setError(null);
    },
    onSuccess: (r, vars) => {
      setConflict(null);
      if (vars.done) toast.success(vars.done, { description: `${r.task.title.length > 60 ? r.task.title.slice(0, 60) + '…' : r.task.title}` });
      qc.setQueryData(['task', r.task.id], r.task);
      qc.invalidateQueries({ queryKey: ['snapshot'] });
    },
    onError: (err, vars) => {
      if (err instanceof ApiError && err.code === 'version_conflict') {
        setConflict({ attempted: vars.label, message: err.message, unseen: err.unseen, at: serverNow() });
        if (err.task) qc.setQueryData(['task', err.task.id], err.task);
        qc.invalidateQueries({ queryKey: ['snapshot'] });
        return;
      }
      if (err instanceof ApiError && err.task) qc.setQueryData(['task', err.task.id], err.task);
      setError(isUnreachable(err) ? UNREACHABLE_ACTION : err instanceof Error ? err.message : String(err));
      qc.invalidateQueries({ queryKey: ['snapshot'] });
    },
  });
  const once = useSingleFlight();
  const mutateAsync = m.mutateAsync;
  const run = useCallback(
    async (body: Parameters<typeof mutateAsync>[0]): Promise<CommandResult> => {
      const r = await once(() =>
        mutateAsync(body).then(
          (): CommandResult => ({ outcome: 'applied' }),
          (err): CommandResult =>
            err instanceof ApiError && err.code === 'version_conflict'
              ? { outcome: 'conflict' }
              : isUnreachable(err)
                ? { outcome: 'unreachable', message: UNREACHABLE_ACTION }
                : { outcome: 'refused', message: err instanceof Error ? err.message : String(err) },
        ),
      );
      return r ?? { outcome: 'ignored' };
    },
    [once, mutateAsync],
  );
  const clearError = useCallback(() => setError(null), []);
  return { run, pending: m.isPending, conflict, clearConflict: () => setConflict(null), error, clearError };
}
