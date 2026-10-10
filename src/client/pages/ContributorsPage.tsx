import { useMemo, useState } from 'react';
import { SearchIcon } from 'lucide-react';
import type { ContributorDto, SnapshotDto } from '../../shared/schemas';
import { plural, taskRef } from '../../shared/format';
import { cn } from '@/lib/utils';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { PageHeader } from '@/components/AppShell';
import { Person, PersonAvatar, Tag, type Presence } from '@/components/status';
import { ExpertiseChip, ExpertiseTile } from '@/components/expertise';
import { LoadDots } from '@/components/task/TaskSheet';

const presenceOf = (c: ContributorDto): Presence => (c.availability === 'away' ? 'away' : c.load >= c.maxActive ? 'full' : 'available');

export function ContributorsPage({ snapshot, onOpenTask }: { snapshot: SnapshotDto; onOpenTask: (id: number) => void }) {
  const [query, setQuery] = useState('');
  const titles = useMemo(() => new Map(snapshot.tasks.map((t) => [t.id, t.title])), [snapshot.tasks]);
  const all = [...snapshot.contributors].sort((a, b) => a.name.localeCompare(b.name));
  const groups: { key: Presence; label: string; people: ContributorDto[] }[] = [
    { key: 'available', label: 'Can take work', people: all.filter((c) => presenceOf(c) === 'available') },
    { key: 'full', label: 'At capacity', people: all.filter((c) => presenceOf(c) === 'full') },
    { key: 'away', label: 'Away', people: all.filter((c) => presenceOf(c) === 'away') },
  ];
  const covered = snapshot.expertise.filter((e) => e.contributorCount > 0).length;
  const q = query.trim().toLowerCase();
  const rows = all.filter((c) => !q || [c.name, c.headline, ...c.expertise.map((e) => e.label)].some((s) => s.toLowerCase().includes(q)));

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={
          <Tag>
            {plural(all.length, 'contributor')} · {covered} of {snapshot.expertise.length} areas covered
          </Tag>
        }
        title="Contributors"
        description="The experts tasks are routed to: what they know, whether they’re available, and how much they’re carrying."
      />

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="rounded-xl bg-card p-5 ring-1 ring-border">
          <div className="text-sm font-medium">Who can take work</div>
          <div className="mt-4 grid gap-5 sm:grid-cols-3">
            {groups.map((g) => (
              <div key={g.key}>
                <div className="flex items-baseline gap-2">
                  <span className="num font-heading text-[28px] leading-none font-semibold tracking-tight">{g.people.length}</span>
                  <span className="text-xs text-ink-2">{g.label}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2.5">
                  {g.people.length === 0 && <span className="text-xs text-muted-foreground">Nobody</span>}
                  {g.people.map((c) => (
                    <Tooltip key={c.id}>
                      <TooltipTrigger asChild>
                        <span tabIndex={0} role="img" aria-label={`${c.name}: ${g.label.toLowerCase()}, ${c.load} of ${c.maxActive} active`} className="rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                          <PersonAvatar name={c.name} presence={g.key} muted={g.key === 'away'} />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {c.name} · {c.load} of {c.maxActive} active
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl bg-card p-5 ring-1 ring-border">
          <div className="text-sm font-medium">Coverage by expertise</div>
          <ul className="mt-3 space-y-2.5">
            {snapshot.expertise.map((e) => (
              <li key={e.id} className="flex items-center gap-3">
                <ExpertiseTile id={e.id} size="sm" />
                <span className="w-32 truncate text-sm">{e.label}</span>
                <span className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-[#efeeea]" aria-hidden>
                  {e.contributorCount > 0 && <span className="h-full rounded-full bg-[#0c9b5a]" style={{ width: `${(e.offerableCount / e.contributorCount) * 100}%` }} />}
                </span>
                <span className={cn('num w-24 text-right font-mono text-[11px]', e.contributorCount === 0 ? 'font-medium text-[#be222a]' : e.offerableCount === 0 ? 'text-[#ab5900]' : 'text-muted-foreground')}>
                  {e.contributorCount === 0 ? 'nobody' : `${e.offerableCount} of ${e.contributorCount} free`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="text-sm font-medium">
            All contributors <span className="num ml-1 font-mono text-xs text-muted-foreground">{all.length}</span>
          </div>
          <InputGroup className="h-9 w-full rounded-lg sm:w-72">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput placeholder="Search names, expertise…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search contributors" />
          </InputGroup>
        </div>
        {rows.length === 0 ? (
          <Empty className="py-14">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="bg-brand-soft text-brand">
                <SearchIcon />
              </EmptyMedia>
              <EmptyTitle>No matching contributors</EmptyTitle>
              <EmptyDescription>Nothing matches “{query.trim()}”.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent [&>th]:h-10 [&>th]:text-xs [&>th]:font-medium [&>th]:text-muted-foreground">
                <TableHead className="pl-5">Contributor</TableHead>
                <TableHead className="w-[250px]">Expertise</TableHead>
                <TableHead className="w-[130px]">Availability</TableHead>
                <TableHead className="w-[140px]">Load</TableHead>
                <TableHead className="w-[200px] pr-5">Active tasks</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => {
                const presence = presenceOf(c);
                return (
                  <TableRow key={c.id} className="h-[60px] border-border/70 hover:bg-[#fafaf8]">
                    <TableCell className="max-w-[340px] pl-5">
                      <Person name={c.name} sub={c.headline} muted={presence === 'away'} presence={presence} />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {c.expertise.map((e) => (
                          <ExpertiseChip key={e.id} id={e.id} label={e.label} />
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className={cn('inline-flex items-center gap-1.5 text-sm', presence === 'away' ? 'text-muted-foreground' : 'text-foreground')}>
                        <span className={cn('size-2 rounded-full', presence === 'away' ? 'bg-[#cfcdc6]' : presence === 'full' ? 'bg-[#f5a524]' : 'bg-[#0c9b5a]')} aria-hidden />
                        {presence === 'away' ? 'Away' : presence === 'full' ? 'Available · full' : 'Available'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <LoadDots load={c.load} max={c.maxActive} />
                    </TableCell>
                    <TableCell className="pr-5">
                      {c.activeTaskIds.length === 0 ? (
                        <span className="text-muted-foreground/50">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {c.activeTaskIds.map((id) => (
                            <button key={id} onClick={() => onOpenTask(id)} title={titles.get(id)} className="rounded-md bg-white px-1.5 py-0.5 font-mono text-xs text-foreground/80 ring-1 ring-border transition-colors hover:bg-brand-soft hover:text-brand hover:ring-brand/30">
                              {taskRef(id)}
                            </button>
                          ))}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
