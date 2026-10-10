import { useMemo, useState } from 'react';
import { ArrowRightIcon, InboxIcon, SearchIcon, WaypointsIcon } from 'lucide-react';
import type { Policy } from '../../shared/policy';
import type { SnapshotDto, TaskRowDto } from '../../shared/schemas';
import { duration, taskRef } from '../../shared/format';
import { detailLine, displayOf, nextCell, STATUS } from '@/lib/copy';
import { cn } from '@/lib/utils';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Person, PriorityIndicator, StatusBadge, TONE } from '@/components/status';
import { ExpertiseTile } from '@/components/expertise';
import { EngineHealth, groupOf, Headline, Pipeline, type Filter, type Group } from '@/components/Overview';

const GROUP_ORDER: Group[] = ['attention', 'in_flight', 'working', 'not_routed', 'settled'];
const PRI_RANK = { high: 0, normal: 1, low: 2 } as const;

/** Sort keys are fixed timestamps, so rows only move when they change group, never on every tick. */
function sortRows(rows: TaskRowDto[], now: number, policy: Policy): TaskRowDto[] {
  const byPri = (a: TaskRowDto, b: TaskRowDto) => PRI_RANK[a.priority] - PRI_RANK[b.priority];
  const overdue = (t: TaskRowDto) => (t.currentAttempt && now - t.currentAttempt.dispatchedAt >= policy.overdueAfterMs ? 0 : 1);
  const due = (t: TaskRowDto) => t.nextAutomaticAction?.at ?? Number.MAX_SAFE_INTEGER;
  const within = (g: Group) => (a: TaskRowDto, b: TaskRowDto) => {
    if (g === 'attention') return byPri(a, b) || a.statusChangedAt - b.statusChangedAt;
    if (g === 'in_flight') return overdue(a) - overdue(b) || byPri(a, b) || due(a) - due(b);
    if (g === 'settled') return (b.closedAt ?? 0) - (a.closedAt ?? 0);
    return byPri(a, b) || b.createdAt - a.createdAt;
  };
  return [...rows].sort((a, b) => {
    const ga = groupOf(a);
    const gb = groupOf(b);
    return GROUP_ORDER.indexOf(ga) - GROUP_ORDER.indexOf(gb) || within(ga)(a, b);
  });
}

const TABS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'attention', label: 'Needs attention' },
  { key: 'in_flight', label: 'In flight' },
  { key: 'working', label: 'Working' },
  { key: 'not_routed', label: 'Not routed' },
  { key: 'settled', label: 'Settled' },
];

const EMPTY: Record<Filter, { title: string; body: string }> = {
  all: { title: 'No tasks yet', body: 'Create a task to start routing it to a contributor.' },
  attention: { title: 'Nothing needs you', body: 'Tasks land here when automation stops: a decline, an expired offer, no match, or retries used up.' },
  in_flight: { title: 'Nothing in flight', body: 'Tasks waiting on the engine or on a contributor’s reply show here.' },
  working: { title: 'Nobody is working on a task', body: 'Accepted and started tasks show here.' },
  not_routed: { title: 'Everything has been routed', body: 'New tasks saved without routing, and tasks you stopped, wait here.' },
  settled: { title: 'Nothing settled yet', body: 'Completed and cancelled tasks show here.' },
};

/** A status change in the last moments gets a brief brand-tint flash, so live changes catch the eye. */
const justChanged = (t: TaskRowDto, now: number) => now - t.statusChangedAt < 1_600;

export function TasksPage({ snapshot, now, offline, selectedId, onSelect }: { snapshot: SnapshotDto; now: number; offline: boolean; selectedId: number | null; onSelect: (id: number) => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const policy = snapshot.policy;
  const offerable = useMemo(() => new Map(snapshot.expertise.map((e) => [e.id, e.offerableCount])), [snapshot.expertise]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: snapshot.tasks.length, attention: 0, in_flight: 0, working: 0, not_routed: 0, settled: 0 };
    for (const t of snapshot.tasks) c[groupOf(t)]++;
    return c;
  }, [snapshot.tasks]);

  const q = query.trim().toLowerCase();
  const rows = sortRows(
    snapshot.tasks.filter((t) => {
      if (filter !== 'all' && groupOf(t) !== filter) return false;
      if (!q) return true;
      const who = t.activeAssignment?.contributorName ?? t.lastOutcome?.contributorName ?? '';
      return [t.title, taskRef(t.id), t.expertiseLabel, who].some((s) => s.toLowerCase().includes(q));
    }),
    now,
    policy,
  );

  return (
    <div className="space-y-5">
      <Headline snapshot={snapshot} now={now} offline={offline} />
      <Pipeline snapshot={snapshot} now={now} offline={offline} filter={filter} onFilter={setFilter} onOpenTask={onSelect} />
      <EngineHealth snapshot={snapshot} />

      {/* A container, so columns give way to the title as the space narrows (sidebar open, panel, small screens). */}
      <div className="@container overflow-hidden rounded-xl bg-card ring-1 ring-border">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)} className="-mx-1 max-w-full overflow-x-auto px-1">
            <TabsList className="h-9 w-max rounded-lg bg-muted p-1">
              {TABS.map((t) => (
                <TabsTrigger key={t.key} value={t.key} className="h-7 rounded-md px-2.5 text-[13px] data-active:shadow-[0_1px_2px_rgb(27_27_23/0.08),0_0_0_1px_rgb(27_27_23/0.05)]">
                  {t.label}
                  <span className={cn('num font-mono text-[11px]', t.key === 'attention' && counts.attention > 0 ? 'font-semibold text-[#be222a]' : 'text-muted-foreground')}>{counts[t.key]}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <InputGroup className="h-9 w-full rounded-lg sm:w-72">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput placeholder="Search tasks, IDs, people…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search tasks" />
          </InputGroup>
        </div>

        {rows.length === 0 ? (
          <Empty className="py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="bg-brand-soft text-brand">
                {q ? <SearchIcon /> : <InboxIcon />}
              </EmptyMedia>
              <EmptyTitle>{q ? 'No matching tasks' : EMPTY[filter].title}</EmptyTitle>
              <EmptyDescription>{q ? `Nothing matches “${query.trim()}” in this view.` : EMPTY[filter].body}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <div className="divide-y @2xl:hidden">
              {rows.map((t) => (
                <TaskCard key={t.id} t={t} now={now} offline={offline} policy={policy} onSelect={onSelect} offerable={offerable.get(t.expertiseId)} />
              ))}
            </div>
            {/* Fixed layout: the listed widths hold and the title takes what's left. Columns hide in order of value. */}
            <Table className="hidden table-fixed @2xl:table">
              <TableHeader>
                <TableRow className="hover:bg-transparent [&>th]:h-10 [&>th]:text-xs [&>th]:font-medium [&>th]:text-muted-foreground">
                  <TableHead className="pl-5">Task</TableHead>
                  <TableHead className="w-[230px]">Status</TableHead>
                  <TableHead className={cn('w-[180px]', COL.contributor)}>Contributor</TableHead>
                  <TableHead className={cn('w-[100px]', COL.priority)}>Priority</TableHead>
                  <TableHead className="w-[140px]">Next</TableHead>
                  <TableHead className={cn('w-[100px] pr-5 text-right', COL.created)}>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((t) => (
                  <TaskRow key={t.id} t={t} now={now} offline={offline} policy={policy} selected={t.id === selectedId} onSelect={onSelect} offerable={offerable.get(t.expertiseId)} />
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </div>
    </div>
  );
}

/** Which columns show at which table width. The title column always keeps at least ~220px. */
const COL = { contributor: 'hidden @3xl:table-cell', priority: 'hidden @4xl:table-cell', created: 'hidden @5xl:table-cell' };

function TaskRow({ t, now, offline, policy, selected, onSelect, offerable }: { t: TaskRowDto; now: number; offline: boolean; policy: Policy; selected: boolean; onSelect: (id: number) => void; offerable?: number }) {
  const display = displayOf(t, now, policy);
  const a = t.activeAssignment;
  const settled = t.status === 'completed' || t.status === 'cancelled';
  const who = a ? a.contributorName : t.status === 'completed' && t.lastOutcome ? t.lastOutcome.contributorName : null;
  const edge = selected ? 'shadow-[inset_3px_0_0_var(--brand)]' : display === 'needs_attention' ? 'shadow-[inset_3px_0_0_#e5484d]' : '';
  return (
    <TableRow
      data-state={selected ? 'selected' : undefined}
      className={cn('h-[60px] cursor-pointer border-border/70 transition-colors hover:bg-[#fafaf8] data-[state=selected]:bg-brand-soft/50', justChanged(t, now) && 'flash')}
      onClick={() => onSelect(t.id)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(t.id))}
      tabIndex={0}
      data-task-id={t.id}
      aria-label={`${taskRef(t.id)} ${t.title}`}
    >
      <TableCell className={cn('pl-5', edge)}>
        <div className="flex min-w-0 items-center gap-3">
          <ExpertiseTile id={t.expertiseId} className={cn(settled && 'opacity-50 grayscale')} />
          <div className="min-w-0">
            <div dir="auto" className={cn('truncate text-sm font-medium', settled ? 'text-muted-foreground' : 'text-foreground')} title={t.title}>
              {t.title}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span className="truncate">
                <span className="font-mono">{taskRef(t.id)}</span> · {t.expertiseLabel}
                {/* When the Contributor column is hidden, who has it still shows here. */}
                {who && <span className="@3xl:hidden"> · {who}</span>}
              </span>
              {/* When the Priority column is hidden, the bars move next to the ID. */}
              <PriorityIndicator priority={t.priority} showLabel={false} className="@4xl:hidden" />
            </div>
          </div>
        </div>
      </TableCell>
      <TableCell>
        <StatusBadge display={display} />
        <div className={cn('num mt-1 truncate text-xs', display === 'overdue' ? 'text-[#ab5900]' : 'text-muted-foreground')}>{detailLine(t, now, policy, offerable)}</div>
      </TableCell>
      <TableCell className={COL.contributor}>
        {who ? <Person name={who} sub={a ? (a.status === 'offered' ? 'Offered' : a.status === 'accepted' ? 'Accepted' : 'Working') : 'Completed'} muted={settled} /> : <span className="text-muted-foreground/50">—</span>}
      </TableCell>
      <TableCell className={COL.priority}>
        <PriorityIndicator priority={t.priority} />
      </TableCell>
      <TableCell>
        <NextCell t={t} now={now} offline={offline} policy={policy} />
      </TableCell>
      <TableCell className={cn('num pr-5 text-right font-mono text-xs text-muted-foreground', COL.created)} title={`Created ${new Date(t.createdAt).toLocaleString()}`}>
        {duration(now - t.createdAt)} ago
      </TableCell>
    </TableRow>
  );
}

/** What the desk will do on its own, as a countdown that drains; or a plain "your call". Offline: the time it's due. */
function NextCell({ t, now, offline, policy }: { t: TaskRowDto; now: number; offline: boolean; policy: Policy }) {
  const next = nextCell(t, now, offline);
  if (next.tone === 'you')
    return (
      <span className="inline-flex items-center gap-1 text-sm font-medium text-[#be222a]">
        Your call <ArrowRightIcon className="size-3.5" />
      </span>
    );
  if (t.status === 'new')
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-ink-2">
        <WaypointsIcon className="size-3.5" /> Route it
      </span>
    );
  if (next.tone === 'none') return <span className="text-muted-foreground/50">—</span>;
  const n = t.nextAutomaticAction!;
  const start = n.kind === 'expire_offer' ? (t.activeAssignment?.offeredAt ?? now) : (t.currentAttempt?.dispatchedAt ?? now);
  const left = Math.max(0, Math.min(1, (n.at - now) / Math.max(1, n.at - start)));
  const display = displayOf(t, now, policy);
  return (
    <div className="w-[118px]">
      <span className={cn('num block font-mono text-[12.5px]', offline ? 'text-muted-foreground' : 'text-foreground')}>{next.text}</span>
      {!offline && (
        <span className="mt-1 block h-[3px] overflow-hidden rounded-full bg-muted" aria-hidden>
          <span className={cn('block h-full rounded-full transition-[width] duration-1000 ease-linear', TONE[STATUS[display].tone].solid)} style={{ width: `${left * 100}%` }} />
        </span>
      )}
    </div>
  );
}

/** Phone layout: the same facts as a table row, stacked. */
function TaskCard({ t, now, offline, policy, onSelect, offerable }: { t: TaskRowDto; now: number; offline: boolean; policy: Policy; onSelect: (id: number) => void; offerable?: number }) {
  const display = displayOf(t, now, policy);
  return (
    <button data-task-id={t.id} className={cn('block w-full space-y-2 px-4 py-3.5 text-left hover:bg-[#fafaf8]', display === 'needs_attention' && 'shadow-[inset_3px_0_0_#e5484d]')} onClick={() => onSelect(t.id)}>
      <div className="flex items-start gap-3">
        <ExpertiseTile id={t.expertiseId} />
        <div className="min-w-0 flex-1">
          <div dir="auto" className="line-clamp-2 text-sm font-medium [overflow-wrap:anywhere]">
            {t.title}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            <span className="font-mono">{taskRef(t.id)}</span> · {t.expertiseLabel}
          </div>
        </div>
        <PriorityIndicator priority={t.priority} showLabel={false} className="mt-1" />
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-11">
        <StatusBadge display={display} />
        <span className="num truncate text-xs text-muted-foreground">{detailLine(t, now, policy, offerable)}</span>
      </div>
      <div className="pl-11">
        <NextCell t={t} now={now} offline={offline} policy={policy} />
      </div>
    </button>
  );
}
