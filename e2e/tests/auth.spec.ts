import { expect, test } from '@playwright/test';

test('a signed-out visitor is sent to sign-in and can try the demo', async ({ page }) => {
  await page.goto('/applications/new');
  await expect(page).toHaveURL(/\/login\?next=/);

  await page.getByRole('main').getByRole('button', { name: 'Try the demo' }).click();

  await expect(page).toHaveURL(/\/applications\/new$/);
  await expect(page.getByText('You are using the shared demo account.')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('main').getByRole('button', { name: 'Try the demo' })).toBeVisible();
});
