// `npm run reset`: delete the local database so the next server start seeds fresh demo data.
// Refuses while the server is running (use "Reset demo" in the Simulation dock instead).
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { lockHolder, lockPath } from '../src/server/infra/lock';

const DB_PATH = process.env.DESK_DB ?? fileURLToPath(new URL('../data/desk.sqlite', import.meta.url));

const holder = lockHolder(DB_PATH);
if (holder !== null) {
  console.error(`The desk is running (pid ${holder}) on this database.\nStop it first, or use "Reset demo" in the Simulation dock.`);
  process.exit(1);
}

if (existsSync(DB_PATH)) {
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'last_tick_at'`).get() as { value: string } | undefined;
    db.close();
    if (row && Date.now() - Number(row.value) < 3_000) {
      console.error('The server looks like it is running (it ticked less than 3s ago).\nStop it first, or use "Reset demo" in the Simulation dock.');
      process.exit(1);
    }
  } catch {
    // Unreadable or old schema: safe to delete.
  }
  for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });
  rmSync(lockPath(DB_PATH), { force: true }); // stale: its owner is gone
  console.log(`Deleted ${DB_PATH}. The next server start seeds fresh demo data.`);
} else {
  console.log('No database yet. The next server start seeds fresh demo data.');
}
