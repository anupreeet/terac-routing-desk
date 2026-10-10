// Desk-wide history: everything that happened, newest first, across every task. Read-only.
import { memo, useMemo, useState } from 'react';
import { HistoryIcon } from 'lucide-react';
import type { ActivityEventDto, EventDto } from '../../shared/schemas';
import { clockTime, taskRef } from '../../shared/format';
import { useActivity } from '@/hooks/data';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { PageHeader } from '@/components/AppShell';
import { ACTOR, ActorIcon } from '@/components/actors';
import { SimBadge, Tag } from '@/components/status';

type ActorFilter = 'all' | EventDto['actor'];

function dayLabel(at: number, now: number): string {
  const d = new Date(at);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

export function ActivityPage({ now, onOpenTask }: { now: number; onOpenTask: (id: number) => void }) {
  const q = useActivity(60);
  const [actor, setActor] = useState<ActorFilter>('all');
  const events = q.events;
  const shown = useMemo(() => (actor === 'all' ? events : events.filter((e) => e.actor === actor)), [events, actor]);
  const groups = useMemo(() => {
    const out: { label: string; items: ActivityEventDto[] }[] = [];
    for (const e of shown) {
      const label = dayLabel(e.at, now);
      if (out.at(-1)?.label !== label) out.push({ label, items: [] });
      out.at(-1)!.items.push(e);
    }
    return out;
  }, [shown, now]);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={<Tag>Desk-wide history</Tag>} title="Activity" description="Everything that happened on the desk, newest first: what the engine answered, what people did, and what the system did on its own." />
      {/* overflow-visible: the day headers stick to the top of the page while scrolling. */}
      <Card className="gap-0 overflow-visible py-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <ToggleGroup type="single" variant="outline" size="sm" value={actor} onValueChange={(v) => v && setActor(v as ActorFilter)} aria-label="Filter by who acted" className="max-w-full flex-wrap">
            <ToggleGroupItem value="all" className="px-3">
              Everyone
            </ToggleGroupItem>
            {(Object.keys(ACTOR) as EventDto['actor'][]).map((a) => (
              <ToggleGroupItem key={a} value={a} className="gap-1.5 px-3">
                <ActorIcon actor={a} className="size-3.5" /> {ACTOR[a].label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <span className="text-xs text-muted-foreground">Updates live</span>
        </div>

        {q.isLoading ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <div>
            {shown.length === 0 ? (
              <Empty className="py-14">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <HistoryIcon />
                  </EmptyMedia>
                  <EmptyTitle>{actor === 'all' ? 'Nothing here yet' : `No ${ACTOR[actor as EventDto['actor']].label.toLowerCase()} activity ${q.hasNextPage ? 'in what’s loaded' : 'yet'}`}</EmptyTitle>
                  <EmptyDescription>
                    {actor === 'all' ? 'Activity appears as soon as something happens on the desk.' : q.hasNextPage ? 'Load older activity to look further back.' : 'Nothing on the desk was done by them.'}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              groups.map((g, i) => (
                <section key={g.label}>
                  <h2 className={cn('sticky top-14 z-10 border-b bg-[#f6f6f3]/90 px-4 py-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase backdrop-blur', i === 0 && 'rounded-t-xl')}>{g.label}</h2>
                  <ol className="divide-y">
                    {g.items.map((e) => (
                      <ActivityRow key={e.id} e={e} onOpenTask={onOpenTask} />
                    ))}
                  </ol>
                </section>
              ))
            )}
            {/* Always reachable, even when a filter hides everything loaded so far. */}
            <div className="flex justify-center border-t p-3">
              {q.hasNextPage ? (
                <Button variant="outline" size="sm" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
                  {q.isFetchingNextPage ? 'Loading…' : 'Load older activity'}
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">That’s everything.</span>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

/** Memoised: rows never change once written, so a new event on top re-renders one row, not the whole page. */
const ActivityRow = memo(function ActivityRow({ e, onOpenTask }: { e: ActivityEventDto; onOpenTask: (id: number) => void }) {
  const ghost = e.type === 'late_result_ignored' || e.type === 'late_response_ignored';
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <ActorIcon actor={e.actor} chip ghost={ghost} />
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm leading-snug [overflow-wrap:anywhere]', ghost && 'text-muted-foreground italic')}>
          {ghost && <span className="mr-1.5 rounded border border-dashed px-1 text-[11px] font-medium text-muted-foreground not-italic">Ignored</span>}
          {e.summary}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium">{ACTOR[e.actor].label}</span>
          <span aria-hidden>·</span>
          <span className="num" title={new Date(e.at).toLocaleString()}>
            {clockTime(e.at)}
          </span>
          {typeof e.payload.simulatedBy === 'string' && <SimBadge />}
        </div>
      </div>
      {e.taskId !== null && (
        <button onClick={() => onOpenTask(e.taskId!)} className="hidden max-w-[260px] shrink-0 items-center gap-1.5 truncate rounded-md border bg-background px-2 py-1 text-xs text-foreground/80 transition-colors hover:border-foreground/25 hover:bg-muted sm:inline-flex" title={e.taskTitle ?? undefined}>
          <span className="font-mono">{taskRef(e.taskId)}</span>
          <span dir="auto" className="truncate text-muted-foreground">
            {e.taskTitle}
          </span>
        </button>
      )}
    </li>
  );
});
