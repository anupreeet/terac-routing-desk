// Structural rules that keep the design honest. Cheap to check, expensive to lose.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}
const server = files(join(ROOT, 'src/server')).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
const client = files(join(ROOT, 'src/client')).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
const offenders = (list: typeof server, re: RegExp, allowed: (p: string) => boolean) => list.filter((f) => re.test(f.text) && !allowed(f.path)).map((f) => f.path);

describe('architecture', () => {
  it('only the simulator touches sim_* tables (the desk can never read a request’s fate)', () => {
    expect(offenders(server, /\bsim_(jobs|task_scenarios)\b/, (p) => p.startsWith('src/server/sim/'))).toEqual([]);
  });
  it('no wall clock outside the clock and logger', () => {
    expect(offenders(server, /Date\.now\(|new Date\(\)/, (p) => p.endsWith('infra/clock.ts') || p.endsWith('infra/log.ts'))).toEqual([]);
  });
  it('no unseeded randomness on the server', () => {
    expect(offenders(server, /Math\.random\(/, () => false)).toEqual([]);
  });
  it('no timers own state: the tick interval in main.ts is the only one', () => {
    expect(offenders(server, /set(Interval|Timeout)\(/, (p) => p.endsWith('server/main.ts'))).toEqual([]);
  });
  it('desk SQL writes live in the repository (plus db setup and the simulator’s own tables)', () => {
    const writes = /\b(INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/;
    expect(offenders(server, writes, (p) => p.endsWith('store/repo.ts') || p.endsWith('infra/db.ts') || p.startsWith('src/server/sim/'))).toEqual([]);
  });
  it('the client never imports server code', () => {
    expect(client.filter((f) => /from ['"].*server\//.test(f.text)).map((f) => f.path)).toEqual([]);
  });
});
