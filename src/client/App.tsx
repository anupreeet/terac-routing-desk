import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ServerOffIcon } from 'lucide-react';
import { useSnapshot } from '@/hooks/data';
import { useNow } from '@/lib/clock';
import { api, ApiError, isUnreachable } from '@/lib/api';
import { useRoute } from '@/lib/router';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { AppSidebar, OfflineBanner, PAGE_TITLE, SiteHeader, useRestartNotice } from '@/components/AppShell';
import { CreateTaskDialog } from '@/components/dialogs/CreateTaskDialog';
import { SimulationSheet } from '@/components/SimulationSheet';
import { TaskSheet } from '@/components/task/TaskSheet';
import { TasksPage } from '@/pages/TasksPage';
import { ContributorsPage } from '@/pages/ContributorsPage';
import { HowItWorksPage } from '@/pages/HowItWorksPage';
import { ActivityPage } from '@/pages/ActivityPage';

export function App() {
  const { snapshot, offlineSince, loading } = useSnapshot();
  const now = useNow();
  const qc = useQueryClient();
  const { page, taskId, go, openTask } = useRoute();
  const [creating, setCreating] = useState(false);
  const [simOpen, setSimOpen] = useState(false);
  const offline = offlineSince !== null;
  useRestartNotice(snapshot);

  // The tab title carries the number of tasks waiting on a decision, so it's visible from another tab.
  const attention = snapshot?.counts.attention ?? 0;
  useEffect(() => {
    document.title = `${attention ? `(${attention}) ` : ''}${PAGE_TITLE[page]} · Routing Desk`;
  }, [page, attention]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable="true"]') !== null;
      // A modal, or any open dropdown, menu or popover (e.g. a select in the panel): N belongs to it, not to us.
      const layer = document.querySelector('[role="dialog"]:not([data-nonmodal]), [role="alertdialog"], [role="listbox"], [role="menu"], [data-slot="popover-content"], [data-slot="hover-card-content"]') !== null;
      if (typing || layer) return;
      if ((e.key === 'n' || e.key === 'N') && !offline) {
        e.preventDefault();
        setCreating(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [offline]);

  return (
    <SidebarProvider>
      <AppSidebar page={page} onNavigate={go} snapshot={snapshot} offlineSince={offlineSince} now={now} onOpenSimulation={() => setSimOpen(true)} />
      <SidebarInset className="min-w-0">
        <SiteHeader page={page} onNewTask={() => setCreating(true)} offline={offline} />
        {offline && <OfflineBanner offlineSince={offlineSince!} now={now} />}
        <div className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 md:px-8 md:py-8">
          {snapshot ? (
            page === 'activity' ? (
              <ActivityPage now={now} onOpenTask={openTask} />
            ) : page === 'contributors' ? (
              <ContributorsPage snapshot={snapshot} onOpenTask={openTask} />
            ) : page === 'how-it-works' ? (
              <HowItWorksPage policy={snapshot.policy} />
            ) : (
              <TasksPage snapshot={snapshot} now={now} offline={offline} selectedId={taskId} onSelect={openTask} />
            )
          ) : loading ? (
            <LoadingState />
          ) : (
            <Empty className="py-24">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ServerOffIcon />
                </EmptyMedia>
                <EmptyTitle>Can’t reach the desk server</EmptyTitle>
                <EmptyDescription>
                  Is it running? Start it with <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">npm run dev</code>. This page reconnects on its own.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </SidebarInset>

      <TaskSheet id={taskId} policy={snapshot?.policy} now={now} offline={offline} onClose={() => openTask(null)} />
      <SimulationSheet open={simOpen} onOpenChange={setSimOpen} snapshot={snapshot} offline={offline} onReset={() => openTask(null)} />
      <CreateTaskDialog
        open={creating}
        snapshot={snapshot}
        offline={offline}
        onClose={() => setCreating(false)}
        onCreate={async (body) => {
          try {
            const r = await api.createTask(body);
            setCreating(false);
            qc.setQueryData(['task', r.task.id], r.task);
            qc.invalidateQueries({ queryKey: ['snapshot'] });
            if (page !== 'tasks') go('tasks');
            openTask(r.task.id);
            return null;
          } catch (err) {
            if (isUnreachable(err)) return 'Couldn’t reach the desk server, so the task may not have been created. Check the board once it reconnects before trying again.';
            return err instanceof ApiError ? err.message : 'Could not create the task.';
          }
        }}
      />
    </SidebarProvider>
  );
}

function LoadingState() {
  return (
    <div className="space-y-6" aria-busy>
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-[108px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-96 rounded-xl" />
    </div>
  );
}
