// The rest of the operator's surface: the board, filters and search, refresh, the conflict guard,
// keyboard shortcuts, the other pages and the simulation controls.
import { expect, test } from '@playwright/test';
import { createTask, openTask, panel, statusCard, toast, watchErrors } from './helpers';

test.describe('desk', () => {
  test('the board shows seeded tasks with time since created, contributors and the state of the operation', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/(waiting on you|Nothing needs you)/);
    await expect(page.getByText('Pipeline')).toBeVisible();
    await expect(page.getByText('Routing engine')).toBeVisible();
    await expect(page.getByRole('row', { name: /T-101/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /T-107/ })).toContainText('Lena Fischer');
    await expect(page.getByRole('columnheader', { name: 'Created' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('pipeline, tabs and search narrow the table', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: /Needs attention/ }).click();
    const rows = page.locator('tbody tr');
    await expect(rows.first()).toContainText('Needs attention');
    for (const text of await rows.allInnerTexts()) expect(text).toContain('Needs attention');

    await page.getByRole('tab', { name: /^All/ }).click();
    await page.getByLabel('Search tasks').fill('T-104');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('insurance claims');
    await page.getByLabel('Search tasks').fill('zzzz no such task');
    await expect(page.getByText('No matching tasks')).toBeVisible();
  });

  test('a refresh keeps the open task (it lives in the URL) and Esc closes it', async ({ page }) => {
    await openTask(page, 107);
    await page.reload();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole('heading', { name: /phase II trial/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await expect(page).not.toHaveURL(/task=/);
  });

  test('clicking another row while the panel is open switches task without closing it', async ({ page }) => {
    await openTask(page, 104);
    await page.getByRole('row', { name: /T-106/ }).click({ position: { x: 60, y: 16 } });
    await expect(panel(page).getByRole('heading', { name: /warehouse-automation/i })).toBeVisible();
    await expect(page).toHaveURL(/task=T-106/);
  });

  test('N opens the new-task dialog; it validates before creating anything', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('n');
    const dialog = page.getByRole('dialog', { name: 'New task' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /Create and route/ }).click();
    await expect(dialog.getByText('Title needs at least 3 characters.')).toBeVisible();
    await expect(dialog.getByText('Choose an expertise area.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('save without routing, then route from the panel', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /New task/ }).click();
    const dialog = page.getByRole('dialog', { name: 'New task' });
    await dialog.getByLabel('Title').fill('E2E saved: data-room review');
    await dialog.getByRole('combobox', { name: 'Expertise' }).click();
    await page.getByRole('option', { name: /^Data analysis/ }).click();
    await dialog.getByRole('button', { name: 'Save without routing' }).click();
    await expect(statusCard(page)).toHaveAttribute('data-status', 'not_routed');
    await panel(page).getByRole('button', { name: 'Route', exact: true }).click();
    await expect(statusCard(page)).toHaveAttribute('data-status', 'routing');
    await expect(toast(page, 'Routing started')).toBeVisible();
  });

  test('stop routing goes back to Not routed after a confirmation, with the note in the history', async ({ page, request }) => {
    const t = await createTask(request, { title: 'E2E stop: tariff analyst', expertiseId: 'finance', sim: { engine: 'lost_always' } });
    await openTask(page, t.id);
    await panel(page).getByRole('button', { name: 'Stop routing' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Stop routing?' });
    await confirm.getByLabel('Note').fill('Client paused the project');
    await confirm.getByRole('button', { name: 'Stop routing' }).click();
    await expect(statusCard(page)).toHaveAttribute('data-status', 'not_routed');
    await panel(page).getByRole('tab', { name: /Activity/ }).click();
    await expect(panel(page).getByText(/Client paused the project/)).toBeVisible();
  });

  test('two operators, one task: the second action is refused and shows what changed', async ({ browser, request }) => {
    const t = await createTask(request, { title: 'E2E conflict: hedge accounting expert', expertiseId: 'finance', submit: false, sim: { engine: 'lost_always' } });
    const a = await (await browser.newContext()).newPage();
    const b = await (await browser.newContext()).newPage();
    await openTask(a, t.id);
    await openTask(b, t.id);
    // Freeze B's view so it acts on a stale version.
    await b.route(`**/api/tasks/${t.id}`, (r) => (r.request().method() === 'GET' ? r.abort() : r.continue()));
    await panel(a).getByRole('button', { name: 'Route', exact: true }).click();
    await expect(statusCard(a)).toHaveAttribute('data-status', 'routing');
    await panel(b).getByRole('button', { name: 'Route', exact: true }).click();
    const alert = b.getByRole('alert').filter({ hasText: 'This task changed while you were looking' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('was not applied');
    await expect(alert).toContainText('Submitted for routing');
  });

  test('cancel requires confirmation and is final', async ({ page, request }) => {
    const t = await createTask(request, { title: 'E2E cancel: duplicate request', expertiseId: 'operations', submit: false });
    await openTask(page, t.id);
    await panel(page).getByRole('button', { name: 'Cancel task' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Back' }).click();
    await expect(statusCard(page)).toHaveAttribute('data-status', 'not_routed');
    await panel(page).getByRole('button', { name: 'Cancel task' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel task' }).click();
    await expect(statusCard(page)).toHaveAttribute('data-status', 'cancelled');
    await expect(panel(page).getByRole('button', { name: /Route|Offer|Cancel task/ })).toHaveCount(0);
  });

  test('activity, contributors and how-routing-works pages', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/');
    await page.getByRole('link', { name: 'Activity' }).or(page.getByRole('button', { name: 'Activity' })).first().click();
    await expect(page).toHaveURL(/\/activity$/);
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
    await expect(page.getByText(/sent to the engine/).first()).toBeVisible();

    await page.getByRole('button', { name: 'Contributors' }).first().click();
    await expect(page).toHaveURL(/\/contributors$/);
    await expect(page.getByRole('row', { name: /Fatima Al-Sayed/ })).toBeVisible();
    await page.getByRole('row', { name: /Lena Fischer/ }).getByRole('button', { name: 'T-107' }).click();
    await expect(panel(page).getByRole('heading', { name: /phase II trial/ })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'How routing works' }).first().click();
    await expect(page.getByRole('heading', { name: 'How routing works' })).toBeVisible();
    await expect(page.getByText('Late answers', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('simulation controls: marking a contributor away is reflected on the contributors page', async ({ page }) => {
    await page.goto('/contributors');
    await page.getByRole('button', { name: 'Simulation controls' }).click();
    const sheet = page.getByRole('dialog', { name: 'Simulation controls' });
    await sheet.getByRole('switch', { name: /Marcus Chen/ }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('row', { name: /Marcus Chen/ })).toContainText('Away');
    await page.getByRole('button', { name: 'Simulation controls' }).click();
    await sheet.getByRole('switch', { name: /Marcus Chen/ }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('row', { name: /Marcus Chen/ })).toContainText('Available');
  });
});

test.describe('edge cases', () => {
  test('a double-click is one action: no false conflict, one history line', async ({ page, request }) => {
    const t = await createTask(request, { title: 'E2E double-click: route once', expertiseId: 'finance', submit: false, sim: { engine: 'lost_always', contributor: 'manual' } });
    await openTask(page, t.id);
    await panel(page).getByRole('button', { name: 'Route', exact: true }).dblclick();
    await expect(statusCard(page)).toHaveAttribute('data-status', 'routing');
    await page.waitForTimeout(1500);
    await expect(page.getByText('This task changed while you were looking')).toHaveCount(0);
    const detail = await (await request.get(`/api/tasks/${t.id}`)).json();
    expect(detail.events.filter((e: { type: string }) => e.type === 'task_submitted')).toHaveLength(1);
  });

  test('a double-click on a simulated reply sends one reply (nothing recorded as ignored)', async ({ page, request }) => {
    const t = await createTask(request, { title: 'E2E double-click: accept once', expertiseId: 'operations', submit: false, sim: { contributor: 'manual' } });
    await openTask(page, t.id);
    await panel(page).getByRole('button', { name: /Offer to someone/ }).click();
    await page.getByRole('dialog', { name: 'Offer to a contributor' }).getByRole('button', { name: 'Send offer' }).click();
    await expect(statusCard(page)).toHaveAttribute('data-status', 'offered');
    await panel(page).getByRole('button', { name: / accepts$/ }).dblclick();
    await expect(statusCard(page)).toHaveAttribute('data-status', 'assigned');
    await page.waitForTimeout(1000);
    const detail = await (await request.get(`/api/tasks/${t.id}`)).json();
    expect(detail.events.filter((e: { type: string }) => e.type === 'late_response_ignored')).toHaveLength(0);
  });

  test('user text is shown as text, never as markup', async ({ page, request }) => {
    const t = await createTask(request, { title: '<img src=x onerror="window.__pwned=1"> “Quotes” & ünïcödé ✓', expertiseId: 'finance', submit: false });
    let dialogs = 0;
    page.on('dialog', (d) => (dialogs++, d.dismiss()));
    await openTask(page, t.id);
    await expect(panel(page).getByRole('heading', { name: /<img src=x/ })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(dialogs).toBe(0);
  });

  test('a decision made in an open dialog is checked against what the operator saw when it opened', async ({ page, request }) => {
    const t = await createTask(request, { title: 'E2E stale dialog: payments benchmark', expertiseId: 'finance', submit: true, sim: { engine: 'quick_match' } });
    await openTask(page, t.id);
    await panel(page).getByRole('button', { name: 'Cancel task' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('We stop waiting for request #1');
    // Behind the open dialog, the engine answers and the task is offered to someone.
    await expect.poll(async () => (await (await request.get(`/api/tasks/${t.id}`)).json()).status, { timeout: 30_000 }).toBe('offered');
    await dialog.getByRole('button', { name: 'Cancel task' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'This task changed while you were looking' })).toBeVisible();
    expect((await (await request.get(`/api/tasks/${t.id}`)).json()).status).toBe('offered');
  });

  test('a link to a task that does not exist says so and can be closed', async ({ page }) => {
    await page.goto('/?task=T-99999');
    await expect(panel(page)).toContainText('doesn’t exist');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
  });
});
