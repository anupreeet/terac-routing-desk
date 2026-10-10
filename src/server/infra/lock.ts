// One desk process per database file. A lock file holds the owner's pid; a lock left behind by a
// process that no longer exists (kill -9, power loss) is taken over.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type Lock = { ok: true; release: () => void } | { ok: false; heldBy: number };

export const lockPath = (dbPath: string) => `${dbPath}.lock`;

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
  }
}

export function lockHolder(dbPath: string): number | null {
  try {
    const pid = Number(readFileSync(lockPath(dbPath), 'utf8').trim());
    return processAlive(pid) && pid !== process.pid ? pid : null;
  } catch {
    return null;
  }
}

export function acquireLock(dbPath: string): Lock {
  if (dbPath === ':memory:') return { ok: true, release: () => {} };
  const path = lockPath(dbPath);
  const mine = String(process.pid);
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, mine, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const holder = lockHolder(dbPath);
    if (holder !== null) return { ok: false, heldBy: holder };
    writeFileSync(path, mine); // stale: its owner is gone
  }
  const release = () => {
    try {
      if (readFileSync(path, 'utf8').trim() === mine) rmSync(path, { force: true });
    } catch {
      // already gone
    }
  };
  process.once('exit', release);
  return { ok: true, release };
}
