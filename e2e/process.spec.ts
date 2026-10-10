// Real processes, against the running e2e server: a second desk must never touch a database that a
// running desk owns, and a bad configuration must fail with a readable message before writing anything.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { spawnSync } from 'node:child_process';

const PORT = Number(process.env.E2E_PORT ?? 3201);

function startDesk(env: Record<string, string>) {
  const r = spawnSync('npx', ['tsx', 'src/server/main.ts'], {
    env: { ...process.env, NODE_ENV: 'production', DESK_DB: '.e2e/desk.sqlite', LOG_FORMAT: 'pretty', ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

async function bootState(request: APIRequestContext) {
  const health = await (await request.get('/api/health')).json();
  const activity = await (await request.get('/api/activity?limit=200')).json();
  const boots = activity.events.filter((e: { type: string }) => e.type === 'desk_restarted' || e.type === 'desk_started').length;
  return { bootId: health.bootId as string, boots };
}

test.describe('a second desk process', () => {
  test('on the same port: exits 1 with a clear message, and the running desk sees no restart', async ({ request }) => {
    const before = await bootState(request);
    const r = startDesk({ PORT: String(PORT) });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/Port \d+ is already in use/);
    expect(await bootState(request)).toEqual(before);
  });

  test('on another port but the same database: exits 1 naming the process that owns it', async ({ request }) => {
    const before = await bootState(request);
    const r = startDesk({ PORT: String(PORT + 7) });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/Another desk process \(pid \d+\) is using/);
    expect(await bootState(request)).toEqual(before);
  });

  test('with a PORT that is not a number: exits 1 before opening the database', async ({ request }) => {
    const before = await bootState(request);
    const r = startDesk({ PORT: 'abc' });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/PORT must be a number/);
    expect(await bootState(request)).toEqual(before);
  });
});
