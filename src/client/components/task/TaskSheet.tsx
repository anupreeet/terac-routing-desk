// The task, opened from anywhere. Top to bottom: what it is and where it is in its life, where it
// stands right now, what happens next and what you can do, then the full record.
// One user action is always exactly one server command.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { LightbulbIcon, RotateCcwIcon, SendIcon, TriangleAlertIcon, UserPlusIcon } from 'lucide-react';
import type { Policy } from '../../../shared/policy';
import type { TaskDetailDto } from '../../../shared/schemas';
import { clockTime, duration, taskRef } from '../../../shared/format';
import { displayOf, exclusionText, heroSentence, STATUS, whatNext, type Tone } from '@/lib/copy';
import { basisOf, isNotFound, useCommand, useTaskDetail, type Basis, type CommandResult, type Conflict } from '@/hooks/data';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Person, PriorityIndicator, StatusBadge } from '@/components/status';
import { ExpertiseTile } from '@/components/expertise';
import { ConfirmDialog, type ConfirmSpec } from '@/components/dialogs/ConfirmDialog';
import { OfferDialog } from '@/components/dialogs/OfferDialog';
import { SimulationCard } from './SimulationCard';
import { TaskRecord } from './TaskRecord';
import { Lifecycle } from './Lifecycle';

type CommandRun = ReturnType<typeof useCommand>['run'];
type Body =
  | { type: 'submit' | 'reroute' | 'stop_routing' | 'revoke_offer' | 'cancel'; note?: string }
  | { type: 'offer'; contributorId: number; acknowledgeExclusion?: boolean; note?: string }
  | { type: 'release'; note: string };
/**
 * label: how the action reads in a conflict ("your route again was not applied"); done: the success toast;
 * basis: the task as the operator saw it when they decided (defaults to the render the click came from).
 */
type RunFn = (label: string, done: string, body: Body, basis?: Basis) => Promise<CommandResult>;

/** The header band takes the status colour: a strong line on top fading into a soft wash. */
const BAND: Record<Tone, { line: string; wash: string }> = {
  red: { line: '#e5484d', wash: '#fff3f1' },
  amber: { line: '#f5a524', wash: '#fff7e0' },
  blue: { line: '#1f2cf4', wash: '#f1f5ff' },
  cyan: { line: '#0797a8', wash: '#ecfbfd' },
  green: { line: '#0c9b5a', wash: '#ecfdf1' },
  gray: { line: '#a19d92', wash: '#f6f6f3' },
  muted: { line: '#cfcdc6', wash: '#f8f8f6' },
};

const dangerGhost = 'text-[#be222a] hover:bg-[#ffedeb] hover:text-[#be222a]';

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function TaskSheet({ id, policy, now, offline, onClose }: { id: number | null; policy?: Policy; now: number; offline: boolean; onClose: () => void }) {
  // Whatever opened the task (a row, a pipeline block, an activity link): focus goes back there on close, and
  // Tab past either end of the panel returns there, so a keyboard user can move on to the next task.
  const opener = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (id === null) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && !content.current?.contains(active)) opener.current = active;
  }, [id]);
  const backToOpener = () => {
    const el = opener.current?.isConnected ? opener.current : id !== null ? document.querySelector<HTMLElement>(`[data-task-id="${id}"]`) : null;
    el?.focus();
    return !!el;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.offsetParent !== null);
    const edge = e.shiftKey ? all[0] : all.at(-1);
    // From the panel itself (where focus lands on open), Tab goes in; Shift+Tab goes back out.
    const atEdge = document.activeElement === edge || (e.shiftKey && document.activeElement === e.currentTarget);
    if (atEdge && backToOpener()) e.preventDefault();
  };
  return (
    // Non-modal: the queue stays visible and clickable, so the operator can move from task to task.
    <Sheet open={id !== null} onOpenChange={(open) => !open && onClose()} modal={false}>
      <SheetContent
        ref={content}
        side="right"
        data-nonmodal=""
        className="w-full gap-0 border-l-0 p-0 shadow-[-24px_0_48px_-24px_rgb(27_27_23/0.18),-1px_0_0_rgb(27_27_23/0.08)] outline-none data-[side=right]:w-full data-[side=right]:sm:max-w-[620px]"
        aria-describedby={undefined}
        onInteractOutside={(e) => e.preventDefault()}
        onKeyDown={onKeyDown}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const active = document.activeElement;
          if (!active || active === document.body || content.current?.contains(active)) backToOpener();
        }}
      >
        {id !== null && policy && <TaskSheetBody key={id} id={id} policy={policy} now={now} offline={offline} />}
      </SheetContent>
    </Sheet>
  );
}

function TaskSheetBody({ id, policy, now, offline }: { id: number; policy: Policy; now: number; offline: boolean }) {
  const q = useTaskDetail(id);
  const t = q.data;
  const cmd = useCommand(t);
  // Dialogs freeze the basis when they open: if the task changes behind an open dialog, confirming is a conflict.
  const [offer, setOffer] = useState<{ preselect?: number; basis: Basis } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);

  // An error from while the desk was unreachable is stale once it's back.
  const { clearError } = cmd;
  useEffect(() => {
    if (!offline) clearError();
  }, [offline, clearError]);

  if (!t) {
    return (
      <>
        <SheetHeader className="border-b px-6 pt-6 pb-5">
          <SheetTitle className="font-mono text-sm text-muted-foreground">{taskRef(id)}</SheetTitle>
          {q.isError ? <SheetDescription>{isNotFound(q.error) ? `${taskRef(id)} doesn’t exist. It may be from before the demo was reset.` : 'This task could not be loaded. Retrying…'}</SheetDescription> : <Skeleton className="h-6 w-2/3" />}
        </SheetHeader>
        {!q.isError && (
          <div className="space-y-4 p-6">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-8 w-1/2" />
          </div>
        )}
      </>
    );
  }

  const display = displayOf(t, now, policy);
  const band = BAND[STATUS[display].tone];
  const disabled = offline || cmd.pending;
  const run: RunFn = (label, done, body, basis) => cmd.run({ ...body, label, done, basis: basis ?? basisOf(t) } as Parameters<CommandRun>[0]);
  const openConfirm = (spec: ConfirmSpec) => setConfirm({ ...spec, basis: basisOf(t) });
  const openOffer = (preselect?: number) => setOffer({ preselect, basis: basisOf(t) });

  return (
    <>
      <SheetHeader className="relative gap-0 overflow-hidden border-b px-6 pt-6 pb-5">
        <span className="absolute inset-x-0 top-0 h-1" style={{ background: band.line }} aria-hidden />
        <span className="absolute inset-0 -z-0" style={{ background: `linear-gradient(to bottom, ${band.wash}, transparent 75%)` }} aria-hidden />
        <div className="relative flex flex-wrap items-center gap-x-2 gap-y-1 pr-8 text-xs text-ink-2">
          <span className="font-mono font-medium text-foreground">{taskRef(t.id)}</span>
          <ExpertiseTile id={t.expertiseId} size="sm" />
          <span>{t.expertiseLabel}</span>
          <span className="text-border-strong">·</span>
          <PriorityIndicator priority={t.priority} className="text-xs" />
        </div>
        <SheetTitle dir="auto" className="relative mt-2 text-[19px] leading-snug font-semibold tracking-[-0.025em] [overflow-wrap:anywhere]">
          {t.title}
        </SheetTitle>
        <SheetDescription className="num relative mt-1 text-xs text-ink-2 [overflow-wrap:anywhere]">
          {t.requestedBy && (
            <>
              Requested by <bdi>{t.requestedBy}</bdi> ·{' '}
            </>
          )}
          created {duration(now - t.createdAt)} ago at {clockTime(t.createdAt)}
        </SheetDescription>
        <div className="relative mt-5">
          <Lifecycle t={t} />
        </div>
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="divide-y">
          <StatusSection t={t} now={now} policy={policy} />

          <Section label="What happens next">
            <WhatNext t={t} now={now} offline={offline} />
            {cmd.conflict && <ConflictAlert c={cmd.conflict} onDismiss={cmd.clearConflict} />}
            {cmd.error && (
              <div role="alert" className="mt-3 flex items-start gap-2.5 rounded-lg bg-[#ffedeb] px-3 py-2.5 text-sm text-[#7d1418]">
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-[#be222a]" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-[#be222a]">That didn’t go through</p>
                  <p>{cmd.error}</p>
                </div>
                <Button size="xs" variant="ghost" onClick={cmd.clearError}>
                  Dismiss
                </Button>
              </div>
            )}
            {t.status === 'needs_attention' ? (
              <DecisionActions t={t} disabled={disabled} run={run} onOffer={() => openOffer()} onConfirm={openConfirm} />
            ) : (
              <Actions t={t} now={now} disabled={disabled} run={run} onOffer={() => openOffer()} onConfirm={openConfirm} />
            )}
          </Section>

          {t.status === 'needs_attention' && <Decision t={t} disabled={disabled} run={run} />}

          {t.lateAnswers.length > 0 && t.status !== 'completed' && t.status !== 'cancelled' && t.status !== 'needs_attention' && (
            <Section label="Late engine answers">
              <LateAnswers t={t} disabled={disabled} onOffer={openOffer} />
            </Section>
          )}

          {t.brief && (
            <Section label="Brief">
              <p dir="auto" className="text-sm leading-relaxed whitespace-pre-line text-ink-2 [overflow-wrap:anywhere]">
                {t.brief}
              </p>
            </Section>
          )}

          <SimulationCard t={t} disabled={offline} />

          <div className="px-6 pt-4 pb-8">
            <TaskRecord t={t} now={now} policy={policy} />
          </div>
        </div>
      </div>

      <OfferDialog
        open={offer !== null}
        task={t}
        preselect={offer?.preselect}
        pending={cmd.pending}
        offline={offline}
        onClose={() => setOffer(null)}
        onSubmit={(contributorId, acknowledgeExclusion, note) => {
          const name = t.candidates.find((c) => c.contributorId === contributorId)?.name ?? 'someone';
          return run(`offer to ${name}`, `Offered to ${name}`, { type: 'offer', contributorId, acknowledgeExclusion, note: note || undefined }, offer?.basis);
        }}
      />
      <ConfirmDialog spec={confirm} pending={cmd.pending} offline={offline} onClose={() => setConfirm(null)} />
    </>
  );
}

function Section({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('px-6 py-5', className)}>
      <h3 className="eyebrow mb-2.5">{label}</h3>
      {children}
    </section>
  );
}

function StatusSection({ t, now, policy }: { t: TaskDetailDto; now: number; policy: Policy }) {
  const display = displayOf(t, now, policy);
  const a = t.currentAttempt;
  return (
    <section data-testid="status-card" data-status={display} className="px-6 py-5" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusBadge display={display} />
          {t.attention && <span className="truncate text-sm font-medium">{t.attention.title}</span>}
        </div>
        {a && (
          <span className="num font-mono text-xs text-muted-foreground">
            Request {a.retryIndex + 1} of {1 + policy.retriesPerRound} · Round {a.round}
          </span>
        )}
      </div>
      <p className={cn('num mt-3 text-[15px] leading-relaxed', display === 'overdue' ? 'text-[#7a4100]' : 'text-foreground')}>{heroSentence(t, now, policy)}</p>
      {a && <WaitBar dispatchedAt={a.dispatchedAt} deadlineAt={a.deadlineAt} now={now} policy={policy} />}
    </section>
  );
}

/** Elapsed time against the engine's usual window: the honest indicator is time, not a spinner. */
function WaitBar({ dispatchedAt, deadlineAt, now, policy }: { dispatchedAt: number; deadlineAt: number; now: number; policy: Policy }) {
  const total = deadlineAt - dispatchedAt;
  const pct = (ms: number) => Math.min(100, Math.max(0, (ms / total) * 100));
  const elapsed = now - dispatchedAt;
  const w = policy.expectedWindowMs;
  const overdue = elapsed >= policy.overdueAfterMs;
  return (
    <div className="mt-4" aria-hidden>
      <div className="relative h-2 overflow-hidden rounded-full bg-[#efeeea]">
        <div className="absolute inset-y-0 bg-brand-soft" style={{ left: `${pct(w.min)}%`, width: `${pct(w.max) - pct(w.min)}%` }} />
        <div className={cn('absolute inset-y-0 left-0 rounded-full transition-[width] duration-1000 ease-linear', overdue ? 'bg-[#f5a524]' : 'bg-brand')} style={{ width: `${pct(elapsed)}%` }} />
        <div className="absolute inset-y-0 w-0.5 bg-foreground/30" style={{ left: `${pct(policy.overdueAfterMs)}%` }} />
      </div>
      <div className="num relative mt-1.5 h-4 font-mono text-[10.5px] text-muted-foreground">
        <span className="absolute left-0">0s</span>
        <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${(pct(w.min) + pct(w.max)) / 2}%` }}>
          usually {w.min / 1000}–{w.max / 1000}s
        </span>
        <span className="absolute right-0">stop waiting {total / 1000}s</span>
      </div>
    </div>
  );
}

function WhatNext({ t, now, offline }: { t: TaskDetailDto; now: number; offline: boolean }) {
  const n = whatNext(t, now, offline);
  return (
    <p className="num text-sm leading-relaxed text-ink-2">
      <span className={cn('font-semibold', n.auto ? 'text-brand' : 'text-foreground')}>{n.lead}</span> {n.rest}
    </p>
  );
}

function ConflictAlert({ c, onDismiss }: { c: Conflict; onDismiss: () => void }) {
  return (
    <div role="alert" className="mt-3 rounded-lg bg-[#fff0cc] px-3.5 py-3 text-sm text-[#5c3200]">
      <div className="flex items-start gap-2.5">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-[#ab5900]" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">This task changed while you were looking</p>
          <p className="mt-0.5">
            Your {c.attempted} was <strong>not</strong> applied. Here’s what changed:
          </p>
          {c.unseen.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {c.unseen.map((e) => (
                <li key={e.id} className="num [overflow-wrap:anywhere]">
                  <span className="font-mono text-xs text-[#ab5900]">{clockTime(e.at)}</span> {e.summary}
                </li>
              ))}
            </ul>
          )}
        </div>
        <Button size="xs" variant="outline" className="bg-white/60" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

function Actions({ t, now, disabled, run, onOffer, onConfirm }: { t: TaskDetailDto; now: number; disabled: boolean; run: RunFn; onOffer: () => void; onConfirm: (s: ConfirmSpec) => void }) {
  const can = (c: string) => t.allowedCommands.includes(c as never);
  if (!t.allowedCommands.length) return null;
  const engaged = t.activeAssignment;
  const a = t.currentAttempt;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      {can('submit') && (
        <Button disabled={disabled} onClick={() => run('route', 'Routing started', { type: 'submit' })}>
          <SendIcon data-icon="inline-start" /> Route
        </Button>
      )}
      {can('offer') && (
        <Button variant={can('submit') ? 'outline' : 'default'} disabled={disabled} onClick={onOffer}>
          <UserPlusIcon data-icon="inline-start" /> Offer to someone…
        </Button>
      )}
      {can('reroute') && (
        <Button
          variant="outline"
          disabled={disabled}
          onClick={() =>
            onConfirm({
              title: 'Route again?',
              body: a ? `We stop waiting for request #${a.seq} (${duration(now - a.dispatchedAt)} so far) and start a new round with a fresh retry budget. If request #${a.seq} answers later, its answer is recorded, not applied.` : 'Start a new routing round with a fresh retry budget.',
              confirmLabel: 'Route again',
              note: 'optional',
              onConfirm: (note, basis) => run('route again', 'Routing again', { type: 'reroute', note }, basis),
            })
          }
        >
          <RotateCcwIcon data-icon="inline-start" /> Route again
        </Button>
      )}
      {can('stop_routing') && (
        <Button
          variant="ghost"
          disabled={disabled}
          onClick={() =>
            onConfirm({
              title: 'Stop routing?',
              body: `We stop waiting for request #${a?.seq} and move the task back to Not routed. Nothing automatic happens until you route it again. A late answer is recorded, not applied.`,
              confirmLabel: 'Stop routing',
              note: 'optional',
              onConfirm: (note, basis) => run('stop routing', 'Routing stopped', { type: 'stop_routing', note }, basis),
            })
          }
        >
          Stop routing
        </Button>
      )}
      {can('revoke_offer') && (
        <Button
          variant="outline"
          disabled={disabled}
          onClick={() =>
            onConfirm({
              title: `Revoke the offer to ${engaged?.contributorName}?`,
              body: `The offer is withdrawn and the task goes back to Not routed. ${engaged?.contributorName} is not excluded, so you can offer it to them again. If they reply afterwards, the reply is recorded, not applied.`,
              confirmLabel: 'Revoke offer',
              note: 'optional',
              danger: true,
              onConfirm: (note, basis) => run('revoke', 'Offer revoked', { type: 'revoke_offer', note }, basis),
            })
          }
        >
          Revoke offer
        </Button>
      )}
      {can('release') && (
        <Button
          variant="outline"
          disabled={disabled}
          onClick={() =>
            onConfirm({
              title: `Release ${engaged?.contributorName}?`,
              body: `Use this when an accepted assignment falls through before work begins (a no-show, a late conflict). The task comes back to you as “fell through before start”, and ${engaged?.contributorName} is excluded from engine routing for this task.`,
              confirmLabel: 'Release',
              note: 'required',
              danger: true,
              onConfirm: (note, basis) => run('release', `Released ${engaged?.contributorName}`, { type: 'release', note: note! }, basis),
            })
          }
        >
          Release…
        </Button>
      )}
      {can('cancel') && (
        <Button
          variant="ghost"
          className={cn(dangerGhost, t.allowedCommands.length > 1 && 'ml-auto')}
          disabled={disabled}
          onClick={() =>
            onConfirm({
              title: 'Cancel this task?',
              body: engaged
                ? `${engaged.contributorName}’s ${engaged.status === 'offered' ? 'offer' : 'assignment'} will be cancelled too. This can’t be undone.`
                : a
                  ? `We stop waiting for request #${a.seq}; a late answer is recorded, not applied. This can’t be undone.`
                  : 'This can’t be undone.',
              confirmLabel: 'Cancel task',
              note: engaged ? 'required' : 'optional',
              danger: true,
              onConfirm: (note, basis) => run('cancel', 'Task cancelled', { type: 'cancel', note }, basis),
            })
          }
        >
          Cancel task
        </Button>
      )}
    </div>
  );
}

/** The three ways forward once automation has stopped. */
function DecisionActions({ t, disabled, run, onOffer, onConfirm }: { t: TaskDetailDto; disabled: boolean; run: RunFn; onOffer: () => void; onConfirm: (s: ConfirmSpec) => void }) {
  const excluded = t.candidates.filter((c) => c.blocker === 'excluded');
  const exclText = excluded.length ? ` (skips ${excluded.map((c) => c.name.split(' ')[0]).join(', ')})` : '';
  // With nobody eligible, routing again comes straight back without asking the engine: not the obvious next step.
  const nobodyEligible = !t.candidates.some((c) => c.blocker === null);
  return (
    <div className="mt-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant={nobodyEligible ? 'outline' : 'default'} disabled={disabled} onClick={() => run('route again', 'Routing again', { type: 'reroute' })}>
          <RotateCcwIcon data-icon="inline-start" /> Route again{exclText}
        </Button>
        {t.candidates.length > 0 && (
          <Button variant="outline" disabled={disabled} onClick={onOffer}>
            <UserPlusIcon data-icon="inline-start" /> Offer to someone…
          </Button>
        )}
        <Button
          variant="ghost"
          className={cn('ml-auto', dangerGhost)}
          disabled={disabled}
          onClick={() => onConfirm({ title: 'Cancel this task?', body: 'This can’t be undone.', confirmLabel: 'Cancel task', note: 'optional', danger: true, onConfirm: (note, basis) => run('cancel', 'Task cancelled', { type: 'cancel', note }, basis) })}
        >
          Cancel task
        </Button>
      </div>
      {nobodyEligible && (
        <p className="text-xs text-muted-foreground">
          {t.candidates.length === 0 ? `Nobody has ${t.expertiseLabel} expertise, so routing again comes straight back here.` : 'Nobody eligible is free, so routing again comes straight back here until someone is.'}
        </p>
      )}
    </div>
  );
}

/** Who is out, who can take it now, and anything the engine said late. */
function Decision({ t, disabled, run }: { t: TaskDetailDto; disabled: boolean; run: RunFn }) {
  const excluded = t.candidates.filter((c) => c.blocker === 'excluded');
  const free = t.candidates.filter((c) => c.blocker === null);
  const blocked = t.candidates.filter((c) => c.blocker === 'away' || c.blocker === 'at_capacity');
  const late = t.lateAnswers.filter((l) => l.contributorId !== null);
  return (
    <Section label="Your decision" className="space-y-5 bg-[#fcfcfa]">
      {late.length > 0 && (
        <div className="rounded-lg bg-brand-soft px-3.5 py-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-brand-strong">
            <LightbulbIcon className="size-3.5" /> The engine answered late. Recorded, not applied.
          </div>
          {late.map((l) => (
            <div key={l.attemptId} className="flex items-center justify-between gap-3 py-0.5 text-sm">
              <span>
                Request #{l.attemptSeq} later picked <strong className="font-medium">{l.contributorName}</strong>
                {!l.offerableNow && l.whyNot && <span className="text-muted-foreground"> · {l.whyNot}</span>}
              </span>
              {l.offerableNow && (
                <Button size="sm" variant="outline" className="bg-white" disabled={disabled} onClick={() => run(`offer to ${l.contributorName}`, `Offered to ${l.contributorName}`, { type: 'offer', contributorId: l.contributorId!, note: `Adopted request #${l.attemptSeq}'s late suggestion` })}>
                  Offer to {l.contributorName?.split(' ')[0]}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <div>
        <h4 className="mb-2 text-xs font-medium text-ink-2">{free.length ? `Can take it now · ${free.length}` : 'Nobody eligible is free right now'}</h4>
        {free.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t.candidates.length === 0
              ? `No contributor has ${t.expertiseLabel} expertise. Cancel the task, or route again once someone is added.`
              : `Everyone with ${t.expertiseLabel} expertise has declined, let an offer expire, or is away or full. You can still offer it to someone who was excluded, wait for capacity, or cancel.`}
          </p>
        ) : (
          <div className="divide-y rounded-lg bg-white ring-1 ring-border">
            {free.map((c) => (
              <div key={c.contributorId} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <Person name={c.name} sub={c.headline} presence="available" />
                </div>
                <LoadDots load={c.load} max={c.maxActive} />
                <Button size="sm" variant="outline" disabled={disabled} onClick={() => run(`offer to ${c.name}`, `Offered to ${c.name}`, { type: 'offer', contributorId: c.contributorId })}>
                  Offer
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {blocked.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-medium text-ink-2">Unavailable</h4>
          <div className="space-y-2">
            {blocked.map((c) => (
              <div key={c.contributorId} className="flex items-center justify-between gap-3">
                <Person name={c.name} muted presence={c.blocker === 'away' ? 'away' : 'full'} />
                <span className="font-mono text-xs text-muted-foreground">{c.blocker === 'away' ? 'Away' : `Full ${c.load}/${c.maxActive}`}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {excluded.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-medium text-ink-2">Skipped by engine routing for this task</h4>
          <div className="space-y-2">
            {excluded.map((c) => (
              <div key={c.contributorId} className="flex items-center justify-between gap-3">
                <Person name={c.name} muted sub={<bdi>{exclusionText(c.exclusion)}</bdi>} />
                <span className="shrink-0 text-xs text-muted-foreground">You can still offer</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

export function LoadDots({ load, max }: { load: number; max: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5" title={`${load} of ${max} active`}>
      <span className="flex gap-0.5" aria-hidden>
        {Array.from({ length: max }, (_, i) => (
          <span key={i} className={cn('h-1.5 w-3 rounded-full', i < load ? (load >= max ? 'bg-[#f5a524]' : 'bg-[#0c9b5a]') : 'bg-[#e4e2dc]')} />
        ))}
      </span>
      <span className="num font-mono text-[11px] text-muted-foreground">
        {load}/{max}
      </span>
    </span>
  );
}

function LateAnswers({ t, disabled, onOffer }: { t: TaskDetailDto; disabled: boolean; onOffer: (preselect?: number) => void }) {
  return (
    <div className="rounded-lg bg-brand-soft px-3.5 py-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-brand-strong">
        <LightbulbIcon className="size-3.5" /> Recorded, not applied
      </div>
      {t.lateAnswers.map((l) => (
        <div key={l.attemptId} className="flex w-full items-center justify-between gap-3 py-0.5 text-sm">
          <span>
            Request #{l.attemptSeq} later picked <strong className="font-medium">{l.contributorName ?? 'no one'}</strong>
            {!l.offerableNow && l.whyNot && <span className="text-muted-foreground"> · {l.whyNot}</span>}
          </span>
          {l.offerableNow && (
            <Button size="sm" variant="outline" className="bg-white" disabled={disabled} onClick={() => onOffer(l.contributorId!)}>
              Offer to {l.contributorName?.split(' ')[0]}…
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
