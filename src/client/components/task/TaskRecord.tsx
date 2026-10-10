// The full record of a task: its timeline, every engine request, every offer. Read-only.
import type { Policy } from '../../../shared/policy';
import type { AssignmentDto, AttemptDto, EventDto, TaskDetailDto } from '../../../shared/schemas';
import { clockTime, duration, plural, secs } from '../../../shared/format';
import type { Tone } from '@/lib/copy';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Person, SimBadge, TonePill } from '@/components/status';
import { ACTOR, ActorIcon } from '@/components/actors';

export function TaskRecord({ t, now, policy }: { t: TaskDetailDto; now: number; policy: Policy }) {
  return (
    <Tabs defaultValue="activity" className="gap-4 pt-1">
      <TabsList variant="line" className="w-full justify-start border-b pb-0">
        <TabsTrigger value="activity" className="flex-none px-2 pb-2">
          Activity <Count n={t.events.length} />
        </TabsTrigger>
        <TabsTrigger value="requests" className="flex-none px-2 pb-2">
          Engine requests <Count n={t.attempts.length} />
        </TabsTrigger>
        <TabsTrigger value="offers" className="flex-none px-2 pb-2">
          Offers <Count n={t.assignments.length} />
        </TabsTrigger>
      </TabsList>
      <TabsContent value="activity">
        <Timeline events={t.events} />
      </TabsContent>
      <TabsContent value="requests">
        <Requests attempts={t.attempts} now={now} policy={policy} />
      </TabsContent>
      <TabsContent value="offers">
        <Offers assignments={t.assignments} />
      </TabsContent>
    </Tabs>
  );
}

function Count({ n }: { n: number }) {
  return <span className="num rounded-full bg-muted px-1.5 text-[11px] leading-4 text-muted-foreground">{n}</span>;
}

function Timeline({ events }: { events: EventDto[] }) {
  return (
    <ol className="relative">
      {events.map((e, i) => {
        const ghost = e.type === 'late_result_ignored' || e.type === 'late_response_ignored';
        const deadlineAt = typeof e.payload.deadlineAt === 'number' ? e.payload.deadlineAt : null;
        const enforcedLate = e.type === 'attempt_timed_out' && deadlineAt !== null && e.at - deadlineAt > 2_000;
        return (
          <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
            {i < events.length - 1 && <span className="absolute top-7 bottom-0 left-[13px] w-px bg-border" aria-hidden />}
            <ActorIcon actor={e.actor} chip ghost={ghost} />
            <div className="min-w-0 flex-1 pt-0.5">
              <p className={cn('text-sm leading-snug [overflow-wrap:anywhere]', ghost ? 'text-muted-foreground italic' : 'text-foreground')}>
                {ghost && (
                  <Badge variant="outline" className="mr-1.5 h-5 rounded-md border-dashed px-1.5 text-[11px] font-medium text-muted-foreground not-italic">
                    Ignored
                  </Badge>
                )}
                {e.summary}
              </p>
              <div className="num mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span className="font-medium">{ACTOR[e.actor].label}</span>
                <span aria-hidden>·</span>
                <span title={new Date(e.at).toLocaleString()}>{clockTime(e.at)}</span>
                {enforcedLate && <span>· due {clockTime(deadlineAt!)}, enforced at startup</span>}
                {!enforcedLate && e.payload.catchUp === true && <span>· processed at startup</span>}
                {typeof e.payload.simulatedBy === 'string' && <SimBadge />}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const ABANDON: Record<string, string> = {
  operator_offer: 'the operator offered directly',
  operator_reroute: 'the operator routed again',
  operator_stop: 'the operator stopped routing',
  task_cancelled: 'the task was cancelled',
};

function attemptView(a: AttemptDto, now: number, policy: Policy): { tone: Tone; label: string; text: string; live?: boolean } {
  const r = a.result;
  const after = (at: number) => secs(at - a.dispatchedAt);
  const late = r && !r.applied && (a.status === 'timed_out' || a.status === 'abandoned') ? ` Answered late after ${after(r.at)}: ${r.contributorName ?? 'no match'} (recorded, not applied).` : '';
  switch (a.status) {
    case 'pending': {
      const e = now - a.dispatchedAt;
      const overdue = e >= policy.overdueAfterMs;
      return { tone: overdue ? 'amber' : 'blue', label: overdue ? 'Overdue' : 'Waiting', live: true, text: `No answer yet (${duration(e)}). We stop waiting at ${clockTime(a.deadlineAt)}.` };
    }
    case 'matched':
      return { tone: 'green', label: 'Matched', text: `Answered in ${after(r!.at)}: picked ${r!.contributorName}, who was offered the task.` };
    case 'no_match':
      return { tone: 'gray', label: 'No match', text: `Answered in ${after(r!.at)}: no suitable contributor.` };
    case 'invalid_result':
      return { tone: 'amber', label: 'Not applied', text: `Answered in ${after(r!.at)}: picked ${r!.contributorName}, but that pick was no longer valid (${a.invalidReason?.replaceAll('_', ' ')}).` };
    case 'timed_out':
      return { tone: 'muted', label: 'Stopped waiting', text: `No answer within ${secs(a.deadlineAt - a.dispatchedAt).replace('.0s', 's')}.${late}` };
    case 'abandoned':
      return { tone: 'muted', label: 'Abandoned', text: `Stopped after ${secs((a.closedAt ?? now) - a.dispatchedAt)} because ${ABANDON[a.abandonReason ?? ''] ?? a.abandonReason}.${late}` };
  }
}

function Requests({ attempts, now, policy }: { attempts: AttemptDto[]; now: number; policy: Policy }) {
  if (!attempts.length) return <p className="py-6 text-center text-sm text-muted-foreground">No engine requests yet. Route the task to send one.</p>;
  return (
    <div className="space-y-2">
      {[...attempts].reverse().map((a) => {
        const v = attemptView(a, now, policy);
        return (
          <div key={a.id} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-semibold">#{a.seq}</span>
                <span className="text-xs text-muted-foreground">
                  Round {a.round}
                  {a.retryIndex > 0 ? ` · retry ${a.retryIndex}` : ''} · sent {clockTime(a.dispatchedAt)} ·{' '}
                  <HoverCard openDelay={150}>
                    <HoverCardTrigger asChild>
                      <button className="underline decoration-dotted underline-offset-2 hover:text-foreground">{plural(a.candidates.length, 'candidate')}</button>
                    </HoverCardTrigger>
                    <HoverCardContent className="w-72">
                      <div className="mb-2 text-xs font-medium text-muted-foreground">Sent to the engine with this request</div>
                      <div className="space-y-1.5">
                        {a.candidates.map((c) => (
                          <div key={c.contributorId} className="flex items-center justify-between text-sm">
                            <span>{c.name}</span>
                            <span className="num text-xs text-muted-foreground">
                              {c.load}/{c.maxActive} active
                            </span>
                          </div>
                        ))}
                        {a.excluded.length > 0 && (
                          <div className="border-t pt-1.5 text-xs text-muted-foreground">Left out: {a.excluded.map((x) => `${x.name} (${x.reason.replaceAll('_', ' ')})`).join(', ')}</div>
                        )}
                      </div>
                    </HoverCardContent>
                  </HoverCard>
                </span>
              </div>
              <TonePill tone={v.tone} icon={v.live ? <span className="size-1.5 animate-pulse rounded-full bg-current" /> : undefined}>
                {v.label}
              </TonePill>
            </div>
            <p className="num mt-1.5 text-sm text-muted-foreground">{v.text}</p>
          </div>
        );
      })}
    </div>
  );
}

const ASSIGNMENT: Record<AssignmentDto['status'], { tone: Tone; label: string }> = {
  offered: { tone: 'cyan', label: 'Offered' },
  accepted: { tone: 'green', label: 'Accepted' },
  in_progress: { tone: 'green', label: 'Working' },
  completed: { tone: 'muted', label: 'Completed' },
  declined: { tone: 'red', label: 'Declined' },
  expired: { tone: 'amber', label: 'No reply' },
  revoked: { tone: 'gray', label: 'Revoked' },
  withdrawn: { tone: 'red', label: 'Withdrew' },
  released: { tone: 'gray', label: 'Released' },
  cancelled: { tone: 'muted', label: 'Cancelled' },
};

function Offers({ assignments }: { assignments: AssignmentDto[] }) {
  if (!assignments.length) return <p className="py-6 text-center text-sm text-muted-foreground">Nobody has been offered this task yet.</p>;
  return (
    <div className="divide-y rounded-lg border">
      {[...assignments].reverse().map((a) => {
        const s = ASSIGNMENT[a.status];
        return (
          <div key={a.id} className="flex items-start gap-3 p-3">
            <div className="min-w-0 flex-1">
              <Person name={a.contributorName} sub={`${a.source === 'engine' ? `Picked by engine request #${a.attemptSeq}` : 'Offered by the operator'} · ${clockTime(a.offeredAt)}`} />
              {a.note && (
                <p className="mt-1.5 ml-9 text-sm whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]">
                  “<bdi>{a.note}</bdi>”
                </p>
              )}
            </div>
            <TonePill tone={s.tone}>{s.label}</TonePill>
          </div>
        );
      })}
    </div>
  );
}
