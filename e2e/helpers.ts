// Shared E2E helpers. Tasks that need a deterministic engine are created through the API (the same
// endpoint the New task dialog uses); everything the operator does is done through the UI.
import { expect, type APIRequestContext, type Page } from '@playwright/test';

export interface CreatedTask {
  id: number;
  title: string;
}

export async function createTask(
  request: APIRequestContext,
  body: { title: string; expertiseId: string; priority?: 'high' | 'normal' | 'low'; submit?: boolean; sim?: { engine?: string; contributor?: string } },
): Promise<CreatedTask> {
  const res = await request.post('/api/tasks', { data: body });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).task as CreatedTask;
}

/** The task panel (a non-modal sheet). */
export const panel = (page: Page) => page.locator('[data-slot="sheet-content"][data-nonmodal]');
export const statusCard = (page: Page) => page.getByTestId('status-card');
export const toast = (page: Page, text: string | RegExp) => page.locator('[data-sonner-toast]', { hasText: text });

export async function openTask(page: Page, id: number): Promise<void> {
  await page.goto(`/?task=T-${id}`);
  await expect(panel(page)).toBeVisible();
  await expect(statusCard(page)).toBeVisible();
}

/** Collects console errors and uncaught exceptions; assert it's empty at the end of a test. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // The browser logs every non-2xx response; expected API refusals (e.g. a 409 conflict) aren't app errors.
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`);
  });
  return errors;
}
