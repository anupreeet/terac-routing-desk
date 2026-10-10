// The top of the Tasks page: a headline that says what needs you, the pipeline (one block per task),
// and how the engine has been behaving. Every number is a count of what happened; nothing predicts a
// pending request.
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { BotIcon, HandIcon } from 'lucide-react';
import type { SnapshotDto, TaskRowDto } from '../../shared/schemas';
import { clockTime, countdown, duration, plural, secs, taskRef } from '../../shared/format';
import { deskLine, displayOf, STATUS } from '@/lib/copy';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Tag } from '@/components/status';

export type Group = 'attention' | 'in_flight' | 'working' | 'not_routed' | 'settled';
export type Filter = Group | 'all';

export function groupOf(t: TaskRowDto): Group {
  switch (t.status) {
    case 'needs_attention':
      return 'attention';
    case 'routing':
    case 'offered':
      return 'in_flight';
    case 'assigned':
    case 'in_progress':
      return 'working';
    case 'new':
      return 'not_routed';
    default:
      return 'settled';
  }
}

function greeting(now: number): string {
  const h = new Date(now).getHours();
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function weekday(now: number): string {
  return new Date(now).toLocaleDateString(undefined, { weekday: 'long' });
}

const hhmm = (at: number) => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function Headline({ snapshot, now, offline }: { snapshot: SnapshotDto; now: number; offline: boolean }) {
  const c = snapshot.counts;
  const nextDeadline = snapshot.tasks.reduce<number | null>((m, t) => (t.nextAutomaticAction && (m === null || t.nextAutomaticAction.at < m) ? t.nextAutomaticAction.at : m), null);
  const title = c.attention ? `${greeting(now)}. ${plural(c.attention, 'task is', 'tasks are')} waiting on you.` : `${greeting(now)}. Nothing needs you right now.`;
  return (
    <div>
      {offline ? (
        <Tag className="bg-[#ffedeb] text-[#be222a]">Offline · last update {clockTime(snapshot.serverNow).slice(0, 5)}</Tag>
      ) : (
        <Tag>
          {weekday(now)} {hhmm(now)} · live
        </Tag>
      )}
      <h1 className="mt-3 font-heading text-[28px] leading-[1.15] font-semibold tracking-[-0.035em] text-balance">{title}</h1>
      <p className="mt-1.5 text-[15px] text-ink-2">
        {deskLine(c, nextDeadline, now, offline).map((p, i) =>
          typeof p === 'string' ? (
            <span key={i}>{p}</span>
          ) : 'mono' in p ? (
            <span key={i} className="num font-mono text-foreground">
              {p.mono}
            </span>
          ) : (
            <span key={i} className="text-[#ab5900]">
              {p.warn}
            </span>
          ),
        )}
      </p>
    </div>
  );
}

const STAGES: { key: Group; label: string; block: string; dot: string }[] = [
  { key: 'attention', label: 'Needs you', block: 'bg-[#e5484d]', dot: 'bg-[#e5484d]' },
  { key: 'not_routed', label: 'Not routed', block: 'bg-[repeating-linear-gradient(135deg,#e4e2dc_0_4px,#f4f4f1_4px_8px)] ring-1 ring-inset ring-[#dedcd6]', dot: 'border border-dashed border-[#a19d92]' },
  { key: 'in_flight', label: 'In flight', block: 'bg-brand', dot: 'bg-brand' },
  { key: 'working', label: 'Working', block: 'bg-[#0c9b5a]', dot: 'bg-[#0c9b5a]' },
  { key: 'settled', label: 'Settled', block: 'bg-[#cfcdc6]', dot: 'bg-[#a19d92]' },
];

function blockClass(t: TaskRowDto): string {
  if (t.status === 'offered') return 'bg-[#0797a8]';
  if (t.status === 'completed') return 'bg-[#1b1b17]';
  if (t.status === 'cancelled') return 'bg-[#dedcd6]';
  if (t.status === 'in_progress') return 'bg-[#00713e]';
  return STAGES.find((s) => s.key === groupOf(t))!.block;
}

/** One block per task reads well up to about this many; beyond it the strip shows each stage's share. */
const PER_TASK_LIMIT = 60;
/** The narrowest a block may get (px) and the gap between blocks: below this, per-task blocks don't fit. */
const MIN_BLOCK = 5;
const BLOCK_GAP = 3;

/** The element's content width, kept current as the layout changes (sidebar, window, panel). */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Needs-you card + a pipeline strip where every task is one block, coloured by where it is. */
export function Pipeline({ snapshot, now, offline, filter, onFilter, onOpenTask }: { snapshot: SnapshotDto; now: number; offline: boolean; filter: Filter; onFilter: (f: Filter) => void; onOpenTask: (id: number) => void }) {
  const c = snapshot.counts;
  const [stripRef, stripWidth] = useWidth<HTMLDivElement>();
  const n = snapshot.tasks.length;
  // One block per task only while every block can stay readable at this width; otherwise each stage's share.
  const perTask = n <= PER_TASK_LIMIT && (stripWidth === null || n * MIN_BLOCK + (n - 1) * BLOCK_GAP <= stripWidth);
  const [focusIdx, setFocusIdx] = useState(0);
  const byGroup = useMemo(() => {
    const m = new Map<Group, TaskRowDto[]>(STAGES.map((s) => [s.key, []]));
    for (const t of snapshot.tasks) m.get(groupOf(t))!.push(t);
    for (const list of m.values()) list.sort((a, b) => a.createdAt - b.createdAt);
    return m;
  }, [snapshot.tasks]);
  const attention = [...byGroup.get('attention')!].sort((a, b) => (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1) || a.statusChangedAt - b.statusChangedAt);
  const oldest = attention.reduce<number | null>((m, t) => (m === null || t.statusChangedAt < m ? t.statusChangedAt : m), null);
  const nextExpiry = c.nextOfferExpiry;
  const working = byGroup.get('working')!;
  const toggle = (g: Group) => onFilter(filter === g ? 'all' : g);

  return (
    // grid-cols-1 (minmax(0, 1fr)): the strip's content must never set the column's width, or it can't shrink to fit.
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2.6fr)]">
      <div
        className={cn(
          'relative overflow-hidden rounded-xl p-5 ring-1 transition-shadow',
          c.attention ? 'bg-gradient-to-br from-[#fff3f1] to-white ring-[#f6c7c2]' : 'bg-card ring-border',
          filter === 'attention' && 'ring-2 ring-[#e5484d]',
        )}
      >
        <button onClick={() => toggle('attention')} aria-pressed={filter === 'attention'} className="absolute inset-0 z-0 rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-label="Show tasks that need you" />
        <div className={cn('pointer-events-none relative flex items-center gap-1.5 text-sm font-medium', c.attention ? 'text-[#be222a]' : 'text-ink-2')}>
          <HandIcon className="size-4" /> Needs you
        </div>
        <div className={cn('num pointer-events-none relative mt-2 font-heading text-[40px] leading-none font-semibold tracking-[-0.04em]', c.attention ? 'text-[#be222a]' : 'text-foreground')}>{c.attention}</div>
        {attention.length > 0 ? (
          <>
            <div className="relative z-10 mt-3 flex flex-wrap gap-1">
              {attention.slice(0, 6).map((t) => (
                <Tooltip key={t.id}>
                  <TooltipTrigger asChild>
                    <button onClick={() => onOpenTask(t.id)} className="rounded-md border border-[#f6c7c2] bg-white px-1.5 py-0.5 font-mono text-[11px] text-[#7d1418] transition-colors hover:border-[#e5484d] hover:bg-[#fff3f1]">
                      {taskRef(t.id)}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t.title} · {t.attention?.short}
                  </TooltipContent>
                </Tooltip>
              ))}
              {attention.length > 6 && <span className="px-1 font-mono text-[11px] text-muted-foreground">+{attention.length - 6}</span>}
            </div>
            <p className="pointer-events-none relative mt-2 text-xs text-ink-2">
              {c.attentionHigh ? `${c.attentionHigh} high priority · ` : ''}oldest {oldest !== null ? duration(now - oldest) : ''}
            </p>
          </>
        ) : (
          <p className="pointer-events-none relative mt-3 text-xs text-ink-2">Automation is handling everything in flight.</p>
        )}
      </div>

      <div className="rounded-xl bg-card p-5 ring-1 ring-border">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Pipeline</span>
          <span className="eyebrow">{plural(snapshot.tasks.length, 'task')}</span>
        </div>
        <div ref={stripRef} className="mt-3 min-w-0 overflow-hidden">
          {!perTask ? (
            // Past a few dozen tasks (or on a narrow screen) one block each stops being readable: show each stage's share.
            <div className="flex h-6 gap-[3px]" role="group" aria-label="Tasks by stage">
              {STAGES.filter((s) => byGroup.get(s.key)!.length > 0).map((s) => {
                const count = byGroup.get(s.key)!.length;
                return (
                  <Tooltip key={s.key}>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => toggle(s.key)}
                        className={cn('h-full min-w-6 rounded-[4px] font-mono text-[10px] leading-6 font-medium text-white transition-transform hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none', s.block, (s.key === 'not_routed' || s.key === 'settled') && 'text-ink-2')}
                        style={{ flexGrow: count, flexBasis: 0 }}
                        aria-label={`${s.label}: ${plural(count, 'task')}`}
                      >
                        {count}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {s.label}: {plural(count, 'task')}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          ) : (
            <BlockStrip blocks={STAGES.flatMap((s) => byGroup.get(s.key)!)} now={now} policy={snapshot.policy} focusIdx={focusIdx} onFocusIdx={setFocusIdx} onOpenTask={onOpenTask} />
          )}
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5">
          {STAGES.map((s) => {
            const n = byGroup.get(s.key)!.length;
            const active = filter === s.key;
            return (
              <button key={s.key} onClick={() => toggle(s.key)} aria-pressed={active} className={cn('rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none', active && 'bg-brand-soft ring-1 ring-brand/30')}>
                <span className="flex items-center gap-1.5 text-xs text-ink-2">
                  <span className={cn('size-2 rounded-full', s.dot)} aria-hidden />
                  {s.label}
                </span>
                <span className="num mt-0.5 block font-heading text-[22px] leading-tight font-semibold tracking-tight">{n}</span>
                <span className="num block h-4 truncate text-[11px] text-muted-foreground">
                  {s.key === 'in_flight' && (c.overdue ? <span className="text-[#ab5900]">{c.overdue} overdue</span> : nextExpiry ? (offline ? `next due ${clockTime(nextExpiry).slice(0, 5)}` : `next ${countdown(nextExpiry - now)}`) : c.routing ? `${c.routing} routing` : '')}
                  {s.key === 'working' && working.map((t) => t.activeAssignment?.contributorName.split(' ')[0]).filter(Boolean).slice(0, 3).join(', ')}
                  {s.key === 'settled' && `${c.done} done · ${c.cancelled} cancelled`}
                  {s.key === 'attention' && (c.attentionHigh ? `${c.attentionHigh} high` : '')}
                  {s.key === 'not_routed' && (n ? 'route when ready' : '')}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Every task as one block. One Tab stop for the whole strip (arrow keys move between blocks), so keyboard users
 * don't have to tab through dozens of blocks to reach the table. Each block names its task and status in words.
 */
function BlockStrip({ blocks, now, policy, focusIdx, onFocusIdx, onOpenTask }: { blocks: TaskRowDto[]; now: number; policy: SnapshotDto['policy']; focusIdx: number; onFocusIdx: (i: number) => void; onOpenTask: (id: number) => void }) {
  const active = Math.min(focusIdx, Math.max(0, blocks.length - 1));
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowRight: active + 1, ArrowDown: active + 1, ArrowLeft: active - 1, ArrowUp: active - 1, Home: 0, End: blocks.length - 1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const next = Math.max(0, Math.min(blocks.length - 1, keys[e.key]));
    onFocusIdx(next);
    e.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  };
  return (
    <div className="flex h-6 gap-[3px]" role="group" aria-label="Every task, by stage. Use the arrow keys to move between tasks." onKeyDown={onKeyDown}>
      {blocks.map((t, i) => {
        const status = STATUS[displayOf(t, now, policy)].label;
        return (
          <Tooltip key={t.id}>
            <TooltipTrigger asChild>
              <button
                tabIndex={i === active ? 0 : -1}
                data-task-id={t.id}
                onFocus={() => onFocusIdx(i)}
                onClick={() => onOpenTask(t.id)}
                className={cn('h-full min-w-[5px] flex-1 rounded-[4px] transition-transform hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none', blockClass(t), t.status === 'routing' && 'shadow-[0_0_10px_rgb(31_44_244/0.45)]')}
                aria-label={`${taskRef(t.id)}, ${status}: ${t.title}`}
              />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <span className="font-mono">{taskRef(t.id)}</span> · {status}
              <span dir="auto" className="block truncate opacity-80">
                {t.title}
              </span>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** How the engine has been doing. The operator can't know about one request, but can see the pattern. */
export function EngineHealth({ snapshot }: { snapshot: SnapshotDto }) {
  const e = snapshot.engine;
  const w = snapshot.policy.expectedWindowMs;
  const closed = e.answered + e.noAnswerByDeadline;
  const answeredPct = closed ? Math.round((e.answered / closed) * 100) : null;
  const segs = [
    { n: e.matched, label: 'Matched', cls: 'bg-[#0c9b5a]' },
    { n: e.noMatch + e.notApplied, label: 'No match or unusable', cls: 'bg-[#a19d92]' },
    { n: e.noAnswerByDeadline, label: 'No answer by the deadline', cls: 'bg-[#f5a524]' },
    { n: e.stoppedByOperator, label: 'Stopped by you', cls: 'bg-[#9aa3ff]' },
    { n: e.pending, label: 'Waiting now', cls: 'bg-brand' },
  ];
  const total = segs.reduce((n, s) => n + s.n, 0);
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-xl bg-card px-5 py-4 ring-1 ring-border">
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-lg bg-brand-soft text-brand [&_svg]:size-4">
          <BotIcon />
        </span>
        <div>
          <div className="text-sm font-medium">Routing engine</div>
          <div className="eyebrow normal-case tracking-normal">last 24h · {plural(e.sent, 'request')}</div>
        </div>
      </div>
      <Stat label="Median answer" value={e.medianAnswerMs !== null ? secs(e.medianAnswerMs) : '—'} hint={`usually ${w.min / 1000}–${w.max / 1000}s`} />
      <Stat label="p90" value={e.p90AnswerMs !== null ? secs(e.p90AnswerMs) : '—'} />
      <Stat label="Answered in time" value={answeredPct !== null ? `${answeredPct}%` : '—'} hint={e.noAnswerByDeadline ? `${e.noAnswerByDeadline} not by the deadline` : undefined} />
      <Stat label="Waiting now" value={String(e.pending)} hint={e.overdue ? `${e.overdue} overdue` : undefined} warn={e.overdue > 0} />
      <div className="min-w-[220px] flex-1">
        <div className="flex h-2 gap-[2px] overflow-hidden rounded-full bg-muted">
          {total > 0 &&
            segs
              .filter((s) => s.n > 0)
              .map((s) => (
                <Tooltip key={s.label}>
                  <TooltipTrigger asChild>
                    <div className={cn('h-full', s.cls)} style={{ width: `${(s.n / total) * 100}%` }} />
                  </TooltipTrigger>
                  <TooltipContent>
                    {s.label}: {s.n}
                  </TooltipContent>
                </Tooltip>
              ))}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          {segs
            .filter((s) => s.n > 0)
            .map((s) => (
              <span key={s.label} className="inline-flex items-center gap-1">
                <span className={cn('size-1.5 rounded-full', s.cls)} aria-hidden />
                {s.label} <span className="num font-mono text-foreground">{s.n}</span>
              </span>
            ))}
          {e.lateAnswers > 0 && <span>· {plural(e.lateAnswers, 'late answer')} recorded, not applied</span>}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, hint, warn }: { label: string; value: ReactNode; hint?: string; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow">{label}</div>
      <div className="num font-mono text-[17px] leading-tight font-medium tracking-tight">{value}</div>
      {hint && <div className={cn('text-[11px]', warn ? 'font-medium text-[#ab5900]' : 'text-muted-foreground')}>{hint}</div>}
    </div>
  );
}
