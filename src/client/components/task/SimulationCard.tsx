// SIMULATION controls for one task. They stand in for the engine and the contributor, never for the
// operator, and they never reveal a request's planned fate.
import { useEffect, useState } from 'react';
import { FlaskConicalIcon } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TaskDetailDto } from '../../../shared/schemas';
import { api, isUnreachable } from '@/lib/api';
import { useSingleFlight } from '@/hooks/data';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/** Simulation buttons: white with violet lettering, never solid, so they never look like the primary action. */
export const simButton = 'border border-sim-border bg-white text-sim-foreground shadow-none hover:bg-sim-muted hover:text-sim-foreground';

export function SimulationCard({ t, disabled }: { t: TaskDetailDto; disabled: boolean }) {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const [note, setNote] = useState('');
  // `disabled` is "offline" here: a message from while the desk was unreachable is stale once it's back.
  useEffect(() => {
    if (!disabled) setMsg(null);
  }, [disabled]);
  const failed = (e: Error) => setMsg(isUnreachable(e) ? 'Couldn’t reach the desk server, so this may not have gone through.' : e.message);
  const done = (task: TaskDetailDto) => {
    qc.setQueryData(['task', task.id], task);
    qc.invalidateQueries({ queryKey: ['snapshot'] });
  };
  const respond = useMutation({
    mutationFn: (v: { assignmentId: number; action: 'accept' | 'decline' | 'start' | 'withdraw' | 'complete'; note?: string }) => api.respond(v.assignmentId, { action: v.action, note: v.note }),
    onSuccess: (r) => (done(r.task), setMsg(null), setNote('')),
    onError: failed,
  });
  const deliver = useMutation({
    mutationFn: (v: { attemptId: number; outcome: 'match' | 'no_match'; contributorId?: number }) => api.deliver(v.attemptId, { outcome: v.outcome, contributorId: v.contributorId }),
    onSuccess: (r) => (done(r.task), setMsg(r.applied ? null : `Delivered, but not applied (${r.reason?.replaceAll('_', ' ')}). See the activity.`)),
    onError: failed,
  });

  // One click = one reply; a double-click must not send a second "accept" that gets recorded as ignored.
  const once = useSingleFlight();
  const answer = (v: Parameters<typeof respond.mutateAsync>[0]) => once(() => respond.mutateAsync(v)).catch(() => {});
  const send = (v: Parameters<typeof deliver.mutateAsync>[0]) => once(() => deliver.mutateAsync(v)).catch(() => {});
  const asg = t.activeAssignment;
  const deliverable = t.attempts.filter((a) => t.sim.deliverableAttemptIds.includes(a.id));
  if (!asg && deliverable.length === 0) return null;
  const busy = disabled || respond.isPending || deliver.isPending;
  const first = asg?.contributorName.split(' ')[0];

  return (
    <section className="px-6 py-5">
      <div className="sim-hatch rounded-xl border border-dashed border-sim-border px-4 py-3.5">
      <div className="flex items-center gap-1.5 font-mono text-[11px] font-medium tracking-[0.06em] text-sim-foreground uppercase">
        <FlaskConicalIcon className="size-3.5 text-sim" /> Simulation · outside world
      </div>
      <p className="mt-1 text-[13px] text-sim-foreground/80">Act as the engine or the contributor. Not an operator action.</p>
      <div className="mt-3 space-y-3">
        {deliverable.map((a) => (
          <DeliverRow key={a.id} attempt={a} busy={busy} onDeliver={(outcome, contributorId) => send({ attemptId: a.id, outcome, contributorId })} />
        ))}
        {asg && (
          <div className="space-y-2">
            <div className="text-sm text-sim-foreground">
              Respond as <strong className="font-semibold">{asg.contributorName}</strong>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {asg.status === 'offered' && (
                <>
                  <Button size="sm" className={simButton} disabled={busy} onClick={() => answer({ assignmentId: asg.id, action: 'accept' })}>
                    {first} accepts
                  </Button>
                  <Button size="sm" variant="outline" className={simButton} disabled={busy} onClick={() => answer({ assignmentId: asg.id, action: 'decline', note: note || undefined })}>
                    {first} declines
                  </Button>
                </>
              )}
              {asg.status === 'accepted' && (
                <>
                  <Button size="sm" className={simButton} disabled={busy} onClick={() => answer({ assignmentId: asg.id, action: 'start' })}>
                    {first} starts work
                  </Button>
                  <Button size="sm" variant="outline" className={simButton} disabled={busy} onClick={() => answer({ assignmentId: asg.id, action: 'withdraw', note: note || undefined })}>
                    {first} withdraws before starting
                  </Button>
                </>
              )}
              {asg.status === 'in_progress' && (
                <Button size="sm" className={simButton} disabled={busy} onClick={() => answer({ assignmentId: asg.id, action: 'complete' })}>
                  {first} completes
                </Button>
              )}
            </div>
            {(asg.status === 'offered' || asg.status === 'accepted') && (
              <Input dir="auto" className="h-8 border-sim-border bg-white" placeholder={`Reason ${first} gives if they ${asg.status === 'offered' ? 'decline' : 'withdraw'} (optional)`} value={note} maxLength={280} onChange={(e) => setNote(e.target.value)} />
            )}
          </div>
        )}
        {msg && <p className="text-xs text-sim-foreground">{msg}</p>}
      </div>
      </div>
    </section>
  );
}

function DeliverRow({ attempt, busy, onDeliver }: { attempt: TaskDetailDto['attempts'][number]; busy: boolean; onDeliver: (o: 'match' | 'no_match', contributorId?: number) => void }) {
  const [who, setWho] = useState<string>(String(attempt.candidates[0]?.contributorId ?? ''));
  return (
    <div className="space-y-2">
      <div className="text-sm text-sim-foreground">
        Engine answers request <span className="font-mono font-semibold">#{attempt.seq}</span> now{attempt.status !== 'pending' ? ' (late)' : ''}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={who} onValueChange={setWho}>
          <SelectTrigger size="sm" className="w-48 border-sim-border bg-white" aria-label="Contributor the engine picks">
            <SelectValue placeholder="Pick a contributor" />
          </SelectTrigger>
          <SelectContent>
            {attempt.candidates.map((c) => (
              <SelectItem key={c.contributorId} value={String(c.contributorId)}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" className={simButton} disabled={busy || who === ''} onClick={() => onDeliver('match', who === '' ? undefined : Number(who))}>
          Deliver match
        </Button>
        <Button size="sm" variant="outline" className={simButton} disabled={busy} onClick={() => onDeliver('no_match')}>
          No match
        </Button>
      </div>
    </div>
  );
}
