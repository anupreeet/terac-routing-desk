// With many tasks the board must stay readable: nothing overflows and the table still filters.
import { expect, test } from '@playwright/test';
import { createTask } from './helpers';

test('120 extra tasks: the pipeline switches to stage shares and nothing overflows the page', async ({ page, request }) => {
  for (let i = 0; i < 120; i++) await createTask(request, { title: `E2E scale task ${i}`, expertiseId: ['finance', 'healthcare', 'data_analysis', 'operations'][i % 4], submit: false });
  await page.goto('/');
  await expect(page.getByLabel('Tasks by stage')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByLabel('Search tasks').fill('scale task 119');
  await expect(page.locator('tbody tr')).toHaveCount(1);
});
