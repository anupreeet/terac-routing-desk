// Offer a task to one specific contributor. Shows who can take it, who can't and why, and who was
// excluded earlier (offering to them needs an explicit acknowledgement).
import { useEffect, useState } from 'react';
import { InfoIcon, TriangleAlertIcon, WifiOffIcon } from 'lucide-react';
import type { CandidateDto, TaskDetailDto } from '../../../shared/schemas';
import { POLICY } from '../../../shared/policy';
import { duration, secs } from '../../../shared/format';
import { serverNow } from '@/lib/clock';
import { exclusionText } from '@/lib/copy';
import { cn } from '@/lib/utils';
import type { CommandResult } from '@/hooks/data';
import { useReturnFocus } from '@/hooks/use-return-focus';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { PersonAvatar } from '@/components/status';

export function OfferDialog({
  open,
  task,
  preselect,
  pending,
  offline,
  onClose,
  onSubmit,
}: {
  open: boolean;
  task: TaskDetailDto;
  preselect?: number;
  pending: boolean;
  offline: boolean;
  onClose: () => void;
  onSubmit: (contributorId: number, acknowledgeExclusion: boolean, note: string) => Promise<CommandResult>;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const [ack, setAck] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setPicked(preselect ?? task.candidates.find((c) => c.blocker === null)?.contributorId ?? null);
      setAck(false);
      setNote('');
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preselect]);
  useEffect(() => {
    if (!offline) setError(null);
  }, [offline]);
  const returnFocus = useReturnFocus(open);

  const chosen = task.candidates.find((c) => c.contributorId === picked) ?? null;
  const pendingReq = task.status === 'routing' ? task.currentAttempt : null;
  const offerable = task.candidates.filter((c) => c.blocker === null);
  const excluded = task.candidates.filter((c) => c.blocker === 'excluded');
  const blocked = task.candidates.filter((c) => c.blocker === 'away' || c.blocker === 'at_capacity');
  const needsAck = chosen?.blocker === 'excluded';
  const canSubmit = chosen !== null && (chosen.blocker === null || (needsAck && ack)) && !pending && !offline;
  const submit = async () => {
    if (!chosen || !canSubmit) return;
    setError(null);
    const r = await onSubmit(chosen.contributorId, needsAck && ack, note.trim());
    // Applied, or the task changed underneath (the panel explains what changed): this decision is done.
    if (r.outcome === 'applied' || r.outcome === 'conflict') onClose();
    else if (r.outcome === 'unreachable' || r.outcome === 'refused') setError(r.message);
  };

  const option = (c: CandidateDto, disabled: boolean, reason?: string) => (
    <Label
      key={c.contributorId}
      htmlFor={`offer-${c.contributorId}`}
      className={cn(
        'flex items-center gap-3 rounded-lg border p-3 font-normal transition-colors',
        disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer hover:bg-muted/50',
        picked === c.contributorId && 'border-foreground/40 bg-muted/60 ring-1 ring-foreground/10',
      )}
    >
      <RadioGroupItem id={`offer-${c.contributorId}`} value={String(c.contributorId)} disabled={disabled} />
      <PersonAvatar name={c.name} muted={disabled} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{c.name}</span>
        <span className={cn('block truncate text-xs', reason && c.blocker === 'excluded' ? 'text-amber-700' : 'text-muted-foreground')}>
          <bdi>{reason ?? c.headline}</bdi>
        </span>
      </span>
      <span className="num shrink-0 text-xs text-muted-foreground" title="Active load">
        {c.load} of {c.maxActive}
      </span>
    </Label>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg" onCloseAutoFocus={returnFocus}>
        <DialogHeader className="min-w-0 px-6 pt-6 pb-4">
          <DialogTitle className="text-lg font-semibold tracking-[-0.02em]">Offer to a contributor</DialogTitle>
          <DialogDescription dir="auto" className="line-clamp-1 [overflow-wrap:anywhere]">
            {task.title}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-6 pb-5">
          {pendingReq && (
            <Alert className="border-blue-200 bg-blue-50/60 px-3 py-2.5 text-blue-950">
              <InfoIcon />
              <AlertDescription className="text-blue-950/80">
                Request #{pendingReq.seq} is still waiting ({duration(serverNow() - pendingReq.dispatchedAt)}). Sending this offer stops the wait. If it answers later, its pick is recorded in the activity, not applied.
              </AlertDescription>
            </Alert>
          )}
          {task.candidates.length > 0 && offerable.length === 0 && excluded.length === 0 && (
            <Alert className="border-amber-200 bg-amber-50/70 px-3 py-2.5 text-amber-950">
              <TriangleAlertIcon />
              <AlertDescription className="text-amber-950/80">
                Nobody can take it right now: everyone with {task.expertiseLabel} expertise is away or at capacity. An offer can be sent once someone frees up.
              </AlertDescription>
            </Alert>
          )}
          {task.candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No contributor has {task.expertiseLabel} expertise, so there is nobody to offer it to.</p>
          ) : (
            <RadioGroup value={picked === null ? '' : String(picked)} onValueChange={(v) => (setPicked(Number(v)), setAck(false))} className="gap-4">
              {offerable.length > 0 && (
                <section className="space-y-2">
                  <h4 className="text-xs font-medium text-muted-foreground">Available · {offerable.length}</h4>
                  {offerable.map((c) => option(c, false))}
                </section>
              )}
              {excluded.length > 0 && (
                <section className="space-y-2">
                  <h4 className="text-xs font-medium text-muted-foreground">Excluded earlier on this task</h4>
                  {excluded.map((c) => option(c, false, exclusionText(c.exclusion)))}
                </section>
              )}
              {blocked.length > 0 && (
                <section className="space-y-2">
                  <h4 className="text-xs font-medium text-muted-foreground">Unavailable</h4>
                  {blocked.map((c) => option(c, true, c.blocker === 'away' ? 'Away' : `At capacity (${c.load} of ${c.maxActive} active)`))}
                </section>
              )}
            </RadioGroup>
          )}
          {needsAck && (
            <Label htmlFor="offer-ack" className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 font-normal text-amber-950">
              <Checkbox id="offer-ack" checked={ack} onCheckedChange={(v) => setAck(v === true)} className="mt-0.5 bg-background" />
              <span className="text-sm leading-snug">
                <TriangleAlertIcon className="mr-1 inline size-3.5 -translate-y-px text-amber-600" />
                Offer anyway. {chosen?.name} is skipped by engine routing for this task, but you can override that.
              </span>
            </Label>
          )}
          <Field>
            <FieldLabel htmlFor="offer-note">Note</FieldLabel>
            <Input id="offer-note" dir="auto" maxLength={280} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional, e.g. client asked for this expert" />
          </Field>
          {(error || offline) && (
            <p role="alert" className="flex items-start gap-2 rounded-lg bg-[#ffedeb] px-3 py-2 text-sm text-[#7d1418]">
              {offline ? <WifiOffIcon className="mt-0.5 size-4 shrink-0 text-[#be222a]" /> : <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-[#be222a]" />}
              <span className="min-w-0 [overflow-wrap:anywhere]">{offline ? 'Can’t reach the desk server. Actions are paused until it reconnects.' : error}</span>
            </p>
          )}
        </div>
        <DialogFooter className="m-0 items-center px-6 py-4">
          <span className="mr-auto hidden text-xs text-muted-foreground sm:block">{chosen ? `${chosen.name.split(' ')[0]} gets ${secs(POLICY.offerTtlMs).replace('.0s', 's')} to reply.` : ''}</span>
          <Button variant="outline" onClick={onClose}>
            Back
          </Button>
          <Button disabled={!canSubmit} onClick={submit}>
            Send offer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
