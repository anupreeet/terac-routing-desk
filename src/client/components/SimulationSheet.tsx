// SIMULATION: global controls for the outside world. Kept in their own violet panel so they can never
// be mistaken for operator actions.
import { useState } from 'react';
import { FlaskConicalIcon, RotateCcwIcon } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { SnapshotDto } from '../../shared/schemas';
import { api } from '@/lib/api';
import { useReturnFocus } from '@/hooks/use-return-focus';
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
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Person } from '@/components/status';
import { simButton } from '@/components/task/SimulationCard';

export function SimulationSheet({ open, onOpenChange, snapshot, offline, onReset }: { open: boolean; onOpenChange: (o: boolean) => void; snapshot?: SnapshotDto; offline: boolean; onReset: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const qc = useQueryClient();
  const returnFocus = useReturnFocus(open);
  const availability = useMutation({
    mutationFn: (v: { id: number; availability: 'available' | 'away' }) => api.setAvailability(v.id, v.availability),
    onSettled: () => qc.invalidateQueries(),
  });
  const reset = useMutation({
    mutationFn: () => api.reset(),
    onSuccess: () => {
      setConfirming(false);
      onOpenChange(false);
      onReset();
      qc.invalidateQueries();
      toast.success('Demo reset', { description: 'All tasks and history were replaced with the seed data.' });
    },
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md" onCloseAutoFocus={returnFocus}>
        <SheetHeader className="sim-hatch border-b border-dashed border-sim-border px-6 pt-6 pb-5">
          <div className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-md bg-sim/10 text-sim [&_svg]:size-4">
              <FlaskConicalIcon />
            </span>
            <SheetTitle className="text-lg font-semibold tracking-[-0.02em] text-sim-foreground">Simulation controls</SheetTitle>
          </div>
          <SheetDescription className="text-sim-foreground/75">
            These stand in for the outside world: the routing engine and the contributors. They are not operator actions, and they never reveal whether a request will answer.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <section>
            <h3 className="text-sm font-medium">Contributor availability</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">Away contributors are skipped by new routing. Offers they already have are unchanged.</p>
            <div className="sim-hatch mt-3 divide-y divide-dashed divide-sim-border rounded-lg border border-dashed border-sim-border">
              {snapshot &&
                [...snapshot.contributors]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((c) => {
                    const away = c.availability === 'away';
                    return (
                      <label key={c.id} htmlFor={`avail-${c.id}`} className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5">
                        <Person name={c.name} sub={away ? 'Away' : 'Available'} muted={away} />
                        {/* Green for "available", as everywhere else; never a solid violet control. */}
                        <Switch
                          id={`avail-${c.id}`}
                          checked={!away}
                          disabled={offline || availability.isPending}
                          onCheckedChange={(on) => availability.mutate({ id: c.id, availability: on ? 'available' : 'away' })}
                          className="data-checked:bg-[#0c9b5a] data-unchecked:bg-[#dedcd6]"
                        />
                      </label>
                    );
                  })}
            </div>
          </section>
          <section>
            <h3 className="text-sm font-medium">Reset the demo</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">Deletes every task and its history and reloads the seed data, including two tasks that start routing live.</p>
            <Button variant="outline" className="mt-3" disabled={offline} onClick={() => setConfirming(true)}>
              <RotateCcwIcon data-icon="inline-start" /> Reset demo…
            </Button>
          </section>
        </div>
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Reset the demo?</AlertDialogTitle>
              <AlertDialogDescription>All tasks and their history are deleted and replaced with the seed data. This can’t be undone.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep everything</AlertDialogCancel>
              <Button className={simButton} disabled={reset.isPending || offline} onClick={() => reset.mutate()}>
                Reset demo
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}
