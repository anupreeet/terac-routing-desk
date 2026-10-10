// Phone width: the table becomes a list and the task panel takes the full screen.
import { expect, test } from '@playwright/test';
import { panel, statusCard } from './helpers';

test('phone layout: list of tasks, open one, read its status', async ({ page }) => {
  await page.goto('/');
  const item = page.getByRole('button', { name: /T-104/ }).first();
  await expect(item).toBeVisible();
  await item.click();
  await expect(panel(page)).toBeVisible();
  await expect(statusCard(page)).toBeVisible();
  const box = await panel(page).boundingBox();
  expect(box!.width).toBeGreaterThan(380);
});
