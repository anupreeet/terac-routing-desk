// The brief's four use cases, end to end in a real browser against the real server, in real time.
import { expect, test } from '@playwright/test';
import { createTask, openTask, panel, statusCard, toast, watchErrors } from './helpers';

test.describe('use cases', () => {
  test('routine assignment: create in the UI, the engine matches, the contributor accepts, starts and completes', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/');
    await page.getByRole('button', { name: /New task/ }).click();
    const dialog = page.getByRole('dialog', { name: 'New task' });
    await dialog.getByLabel('Title').fill('E2E routine: CFO tooling expert call');
    await dialog.getByRole('combobox', { name: 'Expertise' }).click();
    await page.getByRole('option', { name: /^Finance/ }).click();
    await dialog.getByRole('button', { name: /Simulation/ }).click();
    await dialog.getByRole('combobox', { name: 'Engine' }).click();
    await page.getByRole('option', { name: 'Quick match' }).click();
    await dialog.getByRole('button', { name: /Create and route/ }).click();
    await expect(dialog).toBeHidden();

    const p = panel(page);
    await expect(p.getByRole('heading', { name: 'E2E routine: CFO tooling expert call' })).toBeVisible();
    await expect(statusCard(page)).toHaveAttribute('data-status', 'routing');
    await expect(statusCard(page)).toContainText('Waiting for the engine');
    await expect(statusCard(page)).toHaveAttribute('data-status', 'offered', { timeout: 15_000 });

    await p.getByRole('button', { name: / accepts$/ }).click();
    await expect(statusCard(page)).toHaveAttribute('data-status', 'assigned');
    await expect(statusCard(page)).toContainText('Routing is complete');
    await p.getByRole('button', { name: / starts work$/ }).click();
    await expect(statusCard(page)).toHaveAttribute('data-status', 'in_progress');
    await p.getByRole('button', { name: / completes$/ }).click();
    await expect(statusCard(page)).toHaveAttribute('data-status', 'done');

    await p.getByRole('tab', { name: /Activity/ }).click();
    await expect(p.getByText(/Request #1 answered/).first()).toBeVisible();
    await expect(p.getByText(/completed/i).last()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('unresolved routing: a high-priority request with no answer turns Overdue, then retries on its own', async ({ page, request }) => {
    const errors = watchErrors(page);
    const t = await createTask(request, { title: 'E2E unresolved: pharmacovigilance expert', expertiseId: 'healthcare', priority: 'high', sim: { engine: 'lost_always' } });
    await openTask(page, t.id);
    const card = statusCard(page);
    await expect(card).toHaveAttribute('data-status', 'routing');
    await expect(panel(page)).toContainText('Retry in');
    await expect(card).toHaveAttribute('data-status', 'overdue', { timeout: 25_000 });
    await expect(card).toContainText("we can't tell from here");
    await expect(card).not.toContainText(/stuck|failed|lost/i);
    // High priority stops waiting at 30 s and sends request 2 of 3 by itself.
    await expect(card).toContainText('Request 2 of 3', { timeout: 15_000 });
    await expect(card).toHaveAttribute('data-status', 'routing');
    expect(errors).toEqual([]);
  });

  test('human intervention: offer while a request is pending; its late answer is recorded, not applied', async ({ page, request }) => {
    const errors = watchErrors(page);
    const t = await createTask(request, { title: 'E2E intervene: warehouse robotics integrator', expertiseId: 'operations', priority: 'normal', sim: { engine: 'late_answer' } });
    await openTask(page, t.id);
    const p = panel(page);
    await p.getByRole('button', { name: /Offer to someone/ }).click();
    const dlg = page.getByRole('dialog', { name: 'Offer to a contributor' });
    await expect(dlg).toContainText('Request #1 is still waiting');
    await dlg.getByRole('button', { name: 'Send offer' }).click();
    await expect(dlg).toBeHidden();
    await expect(statusCard(page)).toHaveAttribute('data-status', 'offered');
    await expect(toast(page, /^Offered to /)).toBeVisible();

    // Request #1 answers at 40 s. The answer is shown as Ignored and the offer stands.
    await p.getByRole('tab', { name: /Activity/ }).click();
    await expect(p.getByText('Ignored').first()).toBeVisible({ timeout: 50_000 });
    await expect(p.getByText(/Not applied/).first()).toBeVisible();
    await expect(statusCard(page)).toHaveAttribute('data-status', 'offered');
    expect(errors).toEqual([]);
  });

  test('recovery: a declined task explains what happened and routes again without the person who declined', async ({ page }) => {
    const errors = watchErrors(page);
    await openTask(page, 104);
    const p = panel(page);
    await expect(statusCard(page)).toHaveAttribute('data-status', 'needs_attention');
    await expect(statusCard(page)).toContainText('Priya Raman declined');
    await expect(p.getByText('Your decision')).toBeVisible();
    await expect(p.getByText(/Skipped by engine routing for this task/)).toBeVisible();
    await p.getByRole('button', { name: /Route again \(skips Priya\)/ }).click();
    await expect(statusCard(page)).toHaveAttribute('data-status', /routing|offered/);

    await p.getByRole('tab', { name: /Activity/ }).click();
    const sent = p.getByText(/sent to the engine with/).last();
    await expect(sent).toContainText('1 candidate: Fatima Al-Sayed');
    await expect(sent).toContainText('Not sent: Priya Raman (declined this task)');
    expect(errors).toEqual([]);
  });
});
