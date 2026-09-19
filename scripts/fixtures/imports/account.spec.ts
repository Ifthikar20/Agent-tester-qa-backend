import { test, expect } from '@playwright/test';

test.describe('Meridian sign-up', () => {
  test('the sign-up page works', async ({ page }) => {
    await page.goto('{{base}}/form.html');
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
    await page.getByLabel('Name').fill('Ada');
    await page.getByLabel('Plan').selectOption('Yearly');
    await page.getByRole('checkbox', { name: 'Remember me' }).check();
    await page.getByLabel('Name').press('Enter');
    await expect(page.getByText('Yearly plan')).toBeVisible();
  });
});
