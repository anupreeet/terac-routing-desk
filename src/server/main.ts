// Composition root: the only place with a real clock, a real timer and a listening socket.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { checkNode } from './infra/node-guard';
checkNode();

const { openDb, seedState, resetDb } = await import('./infra/db');
const { acquireLock } = await import('./infra/lock');
const { systemClock } = await import('./infra/clock');
const { createLogger } = await import('./infra/log');
const { createApp } = await import('./app');
const { seedDemo } = await import('./seed/seed');

const log = createLogger();
const DB_PATH = process.env.DESK_DB ?? fileURLToPath(new URL('../../data/desk.sqlite', import.meta.url));
const PORT_RAW = process.env.PORT ?? process.env.API_PORT ?? '3001';
const SEED = process.env.SEED ?? '42';
const STATIC_DIR = process.env.NODE_ENV === 'production' ? fileURLToPath(new URL('../../dist/client', import.meta.url)) : undefined;

/** Startup problems are configuration problems: say what to do, not a stack trace. */
function fail(message: string): never {
  log.error('startup.failed', { message });
  process.exit(1);
}

const PORT = /^\d{1,5}$/.test(PORT_RAW) && Number(PORT_RAW) <= 65_535 ? Number(PORT_RAW) : fail(`PORT must be a number between 0 and 65535 (got "${PORT_RAW}").`);

// Claim the port BEFORE touching the database, so a second copy of the desk exits without writing a byte.
// Requests can't be handled before start() returns: boot is synchronous and the handler is attached at its end.
const server = createServer();
server.once('error', (err: NodeJS.ErrnoException) =>
  fail(
    err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Is the desk already running? Stop it, or start this one with PORT=<another port>.` : `Can't listen on port ${PORT}: ${err.message}`,
  ),
);
server.listen(PORT, start);

function start() {
  // Same database, different port: refuse too. Two desks would each enforce deadlines and write history.
  let lock: ReturnType<typeof acquireLock>;
  try {
    lock = acquireLock(DB_PATH);
  } catch (err) {
    fail(`Can't create the lock file next to ${DB_PATH}: ${(err as Error).message}. Check the folder is writable, or set DESK_DB.`);
  }
  if (!lock.ok) fail(`Another desk process (pid ${lock.heldBy}) is using ${DB_PATH}. Stop it first, or set DESK_DB to a different file.`);

  let sql: ReturnType<typeof openDb>;
  try {
    sql = openDb(DB_PATH);
  } catch (err) {
    fail(`Can't open the database at ${DB_PATH}: ${(err as Error).message}. Check the path is writable, or run \`npm run reset\`.`);
  }
  const app = createApp({ sql, clock: systemClock, seed: SEED, log, staticDir: STATIC_DIR });

  const state = seedState(sql);
  if (state === 'partial') {
    // A previous first start was killed mid-seed. Demo data is all there is in it, so start it over.
    log.warn('seed.incomplete', { db: DB_PATH, action: 'reseeding' });
    resetDb(sql);
  }
  if (state !== 'seeded') {
    seedDemo(app, systemClock.now());
    log.info('seeded', { db: DB_PATH });
  }

  // Catch up on everything that came due while we were down, BEFORE handling a single request.
  const booted = app.boot();
  log.info('boot', { bootId: booted.bootId, offlineMs: booted.offlineMs, ...booted.report, db: DB_PATH });

  // The only timer in server code. It owns no state: deadlines are rows; this just enforces them promptly.
  const ticker = setInterval(() => {
    try {
      app.tick();
    } catch (err) {
      log.error('tick.failed', { error: (err as Error).stack ?? String(err) });
    }
  }, app.policy.tickMs);

  server.on('request', app.http);
  log.info('listening', { url: `http://localhost:${PORT}`, ui: STATIC_DIR ? `http://localhost:${PORT}` : 'http://localhost:5173 (npm run dev:web)' });

  let stopping = false;
  let closed = false;
  const finish = (code: number) => {
    if (!closed) {
      closed = true;
      try {
        app.tick(); // a final heartbeat, so the restart summary measures downtime accurately
        sql.close();
      } catch (err) {
        log.error('shutdown.failed', { error: (err as Error).message });
        code = 1;
      }
      lock.release();
    }
    process.exit(code);
  };
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutdown', { signal });
    clearInterval(ticker);
    server.close(() => finish(0));
    server.closeIdleConnections();
    setTimeout(() => finish(1), 2_000).unref(); // a connection that won't close: still checkpoint, but say it wasn't clean
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
