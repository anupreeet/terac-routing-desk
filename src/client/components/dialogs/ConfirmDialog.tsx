// Confirm an operator action, with an optional or required note that goes into the task's history.
// The task as the operator saw it is frozen when the dialog opens (`basis`), so a change behind the open
// dialog comes back as a conflict instead of being overwritten.
import { useEffect, useState } from 'react';
import { TriangleAlertIcon, WifiOffIcon } from 'lucide-react';
import type { Basis, CommandResult } from '@/hooks/data';
import { useReturnFocus } from '@/hooks/use-return-focus';
import { cn } from '@/lib/utils';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

export interface ConfirmSpec {
  title: string;
  body: string;
  confirmLabel: string;
  note: 'none' | 'optional' | 'required';
  danger?: boolean;
  /** Set by whoever opens the dialog: the task version and last event seen at that moment. */
  basis?: Basis;
  onConfirm: (note: string | undefined, basis: Basis | undefined) => Promise<CommandResult>;
}

export function ConfirmDialog({ spec, pending, offline, onClose }: { spec: ConfirmSpec | null; pending: boolean; offline: boolean; onClose: () => void }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setNote('');
    setError(null);
  }, [spec]);
  useEffect(() => {
    if (!offline) setError(null);
  }, [offline]);
  const returnFocus = useReturnFocus(spec !== null);
  const needsNote = spec?.note === 'required' && note.trim().length === 0;
  const submit = async () => {
    if (!spec || needsNote || offline || pending) return;
    setError(null);
    const r = await spec.onConfirm(note.trim() || undefined, spec.basis);
    // Applied, or the task changed underneath (the panel explains what changed): either way this decision is done.
    if (r.outcome === 'applied' || r.outcome === 'conflict') onClose();
    // The desk didn't answer or said no: keep the dialog and what was typed, and say why.
    else if (r.outcome === 'unreachable' || r.outcome === 'refused') setError(r.message);
  };
  return (
    <AlertDialog open={spec !== null} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent className="sm:max-w-md" onCloseAutoFocus={returnFocus}>
        <AlertDialogHeader className="min-w-0">
          <AlertDialogTitle className="[overflow-wrap:anywhere]">{spec?.title}</AlertDialogTitle>
          <AlertDialogDescription className="leading-relaxed [overflow-wrap:anywhere]">{spec?.body}</AlertDialogDescription>
        </AlertDialogHeader>
        {spec && spec.note !== 'none' && (
          <Field className="min-w-0">
            <FieldLabel htmlFor="confirm-note">{spec.note === 'required' ? 'Reason' : 'Note'}</FieldLabel>
            <Textarea
              id="confirm-note"
              autoFocus
              dir="auto"
              rows={2}
              maxLength={280}
              value={note}
              placeholder={spec.note === 'required' ? 'Required' : 'Optional'}
              className="max-h-40 min-w-0 [overflow-wrap:anywhere]"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
              }}
            />
            <FieldDescription>Saved in the task’s activity.</FieldDescription>
          </Field>
        )}
        {(error || offline) && (
          <p role="alert" className="flex items-start gap-2 rounded-lg bg-[#ffedeb] px-3 py-2 text-sm text-[#7d1418]">
            {offline ? <WifiOffIcon className="mt-0.5 size-4 shrink-0 text-[#be222a]" /> : <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-[#be222a]" />}
            <span className="min-w-0 [overflow-wrap:anywhere]">{offline ? 'Can’t reach the desk server. Actions are paused until it reconnects; what you typed is kept.' : error}</span>
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Back</AlertDialogCancel>
          <Button className={cn(spec?.danger && 'bg-destructive text-white hover:bg-destructive/90')} disabled={pending || needsNote || offline} onClick={submit}>
            {spec?.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
