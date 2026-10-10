import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2Icon, ChevronRightIcon, FlaskConicalIcon, TriangleAlertIcon, WifiOffIcon } from 'lucide-react';
import type { SnapshotDto } from '../../../shared/schemas';
import { PRIORITIES, type Priority } from '../../../shared/policy';
import { CONTRIBUTOR_PRESETS, ENGINE_PRESETS } from '../../../shared/sim-presets';
import { secs } from '../../../shared/format';
import { PRIORITY } from '@/lib/copy';
import { cn } from '@/lib/utils';
import { useReturnFocus } from '@/hooks/use-return-focus';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { PriorityIndicator } from '@/components/status';

export interface CreateTaskInput {
  title: string;
  brief: string;
  expertiseId: string;
  priority: Priority;
  submit: boolean;
  sim: { engine: string; contributor: string };
}

export function CreateTaskDialog({ open, snapshot, offline, onClose, onCreate }: { open: boolean; snapshot?: SnapshotDto; offline: boolean; onClose: () => void; onCreate: (body: CreateTaskInput) => Promise<string | null> }) {
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [expertiseId, setExpertiseId] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [simOpen, setSimOpen] = useState(false);
  const [engine, setEngine] = useState('realistic');
  const [contributor, setContributor] = useState('manual');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [restored, setRestored] = useState(false);

  // Esc or a click outside keeps the draft for next time; only Cancel or a created task clears it.
  const clearDraft = () => {
    setTitle('');
    setBrief('');
    setExpertiseId('');
    setPriority('normal');
    setSimOpen(false);
    setEngine('realistic');
    setContributor('manual');
  };
  useEffect(() => {
    if (open) {
      setError(null);
      setTouched(false);
      setRestored(title.trim() !== '' || brief.trim() !== '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!offline) setError(null);
  }, [offline]);
  const returnFocus = useReturnFocus(open);

  const area = useMemo(() => snapshot?.expertise.find((e) => e.id === expertiseId), [snapshot, expertiseId]);
  const titleError = touched && title.trim().length < 3 ? 'Title needs at least 3 characters.' : null;
  const expertiseError = touched && !expertiseId ? 'Choose an expertise area.' : null;
  const valid = title.trim().length >= 3 && title.trim().length <= 120 && expertiseId !== '';
  const policy = snapshot?.policy;

  const inFlight = useRef(false);
  const submit = async (submitNow: boolean) => {
    setTouched(true);
    // A ref, not just state: two Enter presses inside one frame must still create one task.
    if (!valid || busy || offline || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const err = await onCreate({ title: title.trim(), brief: brief.trim(), expertiseId, priority, submit: submitNow, sim: { engine, contributor } }).finally(() => {
      inFlight.current = false;
    });
    setBusy(false);
    if (err) setError(err);
    else clearDraft();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-0 p-0 sm:max-w-xl" onCloseAutoFocus={returnFocus}>
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="text-lg font-semibold tracking-[-0.02em]">New task</DialogTitle>
          <DialogDescription>
            Describe the work and the expertise it needs. Routing sends it to the engine to pick a contributor.
            {restored && <span className="mt-1 block text-xs text-brand">Your unsaved draft is back. Cancel discards it.</span>}
          </DialogDescription>
        </DialogHeader>
        <form
          className="max-h-[65vh] overflow-y-auto px-6 pb-5"
          onSubmit={(e) => {
            e.preventDefault();
            submit(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit(true);
            }
          }}
        >
          <FieldGroup className="gap-5">
            <Field data-invalid={titleError ? true : undefined}>
              <FieldLabel htmlFor="task-title">Title</FieldLabel>
              <Input id="task-title" autoFocus dir="auto" value={title} maxLength={120} aria-invalid={titleError ? true : undefined} onChange={(e) => setTitle(e.target.value)} onBlur={() => title && setTouched(true)} placeholder="e.g. Expert call: hospital procurement for surgical supplies" />
              {titleError && <FieldError>{titleError}</FieldError>}
            </Field>

            <Field data-invalid={expertiseError ? true : undefined}>
              <FieldLabel htmlFor="task-expertise">Expertise</FieldLabel>
              <Select value={expertiseId} onValueChange={setExpertiseId}>
                <SelectTrigger id="task-expertise" className="w-full" aria-invalid={expertiseError ? true : undefined}>
                  <SelectValue placeholder="Choose an area" />
                </SelectTrigger>
                <SelectContent>
                  {snapshot?.expertise.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      <span>{e.label}</span>
                      <span className={cn('ml-auto text-xs', e.offerableCount ? 'text-muted-foreground' : 'text-amber-700')}>{e.offerableCount ? `${e.offerableCount} available` : 'nobody free'}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {expertiseError ? (
                <FieldError>{expertiseError}</FieldError>
              ) : area ? (
                area.offerableCount > 0 ? (
                  <FieldDescription className="flex items-center gap-1.5 text-emerald-700">
                    <CheckCircle2Icon className="size-3.5" /> {area.offerableCount} of {area.contributorCount} {area.label} contributors can take it now.
                  </FieldDescription>
                ) : (
                  <FieldDescription className="flex items-start gap-1.5 text-amber-700">
                    <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      {area.contributorCount === 0 ? `No contributor has ${area.label} expertise.` : `No ${area.label} contributor is free right now.`} If you route it, it goes straight to Needs attention and the engine isn’t
                      called.
                    </span>
                  </FieldDescription>
                )
              ) : (
                <FieldDescription>Each task needs exactly one area.</FieldDescription>
              )}
            </Field>

            <Field>
              <FieldLabel>Priority</FieldLabel>
              <ToggleGroup type="single" variant="outline" value={priority} onValueChange={(v) => v && setPriority(v as Priority)} className="w-full">
                {PRIORITIES.map((p) => (
                  <ToggleGroupItem key={p} value={p} className="flex-1 gap-2 data-[state=on]:bg-muted">
                    <PriorityIndicator priority={p} showLabel={false} className="text-foreground" /> {PRIORITY[p].label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              {policy && (
                <FieldDescription>
                  If a request gets no answer in {secs(policy.requestDeadlineMs[priority]).replace('.0s', 's')}, we stop waiting and retry, up to {policy.retriesPerRound} times. Higher priority waits less.
                </FieldDescription>
              )}
            </Field>

            <Field>
              <FieldLabel htmlFor="task-brief">
                Brief <span className="font-normal text-muted-foreground">(optional)</span>
              </FieldLabel>
              <Textarea id="task-brief" dir="auto" rows={3} maxLength={1000} className="max-h-48 [overflow-wrap:anywhere]" value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Context the contributor needs" />
            </Field>

            <Collapsible open={simOpen} onOpenChange={setSimOpen} className="sim-hatch rounded-xl border border-dashed border-sim-border">
              <CollapsibleTrigger className="flex w-full items-center gap-2 px-3.5 py-3 text-left text-sm">
                <ChevronRightIcon className={cn('size-4 text-sim-foreground/70 transition-transform', simOpen && 'rotate-90')} />
                <FlaskConicalIcon className="size-4 text-sim" />
                <span className="font-mono text-[11px] font-medium tracking-[0.06em] text-sim-foreground uppercase">Simulation</span>
                <span className="truncate text-xs text-sim-foreground/75">
                  Engine: {ENGINE_PRESETS.find((p) => p.id === engine)?.label} · First contributor: {CONTRIBUTOR_PRESETS.find((p) => p.id === contributor)?.label}
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="space-y-4 border-t border-dashed border-sim-border bg-white/70 px-3.5 py-3.5">
                  <p className="text-xs text-sim-foreground/80">Demo only. Decides in advance how the pretend engine and the first contributor offered this task behave. Once the task exists the desk never reveals it.</p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="sim-engine" className="text-sim-foreground">
                        Engine
                      </FieldLabel>
                      <Select value={engine} onValueChange={setEngine}>
                        <SelectTrigger id="sim-engine" className="w-full bg-background">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ENGINE_PRESETS.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FieldDescription className="text-xs">{ENGINE_PRESETS.find((p) => p.id === engine)?.hint}</FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="sim-contributor" className="text-sim-foreground">
                        First contributor offered
                      </FieldLabel>
                      <Select value={contributor} onValueChange={setContributor}>
                        <SelectTrigger id="sim-contributor" className="w-full bg-background">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CONTRIBUTOR_PRESETS.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FieldDescription className="text-xs">{CONTRIBUTOR_PRESETS.find((p) => p.id === contributor)?.hint}</FieldDescription>
                    </Field>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </FieldGroup>
        </form>
        {(error || offline) && (
          <p role="alert" className="mx-6 mb-1 flex items-start gap-2 rounded-lg bg-[#ffedeb] px-3 py-2 text-sm text-[#7d1418]">
            {offline ? <WifiOffIcon className="mt-0.5 size-4 shrink-0 text-[#be222a]" /> : <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-[#be222a]" />}
            <span className="min-w-0 [overflow-wrap:anywhere]">{offline ? 'Can’t reach the desk server. Creating is paused until it reconnects; your draft is kept.' : error}</span>
          </p>
        )}
        <DialogFooter className="m-0 items-center px-6 py-4">
          <Button
            variant="ghost"
            onClick={() => {
              clearDraft();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button variant="outline" disabled={busy || offline} onClick={() => submit(false)}>
            Save without routing
          </Button>
          <Button disabled={busy || offline} onClick={() => submit(true)}>
            Create and route <Kbd className="ml-1 hidden bg-primary-foreground/15 text-primary-foreground sm:inline-flex">⌘↵</Kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
