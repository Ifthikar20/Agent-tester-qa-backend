import { test, expect } from '@playwright/test';

test.describe('Meridian account', () => {
  test('the sign-in page is there', async ({ page }) => {
    await page.goto('{{base}}/demo.html');
    await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
    await page.getByLabel('Email').fill('qa@example.com');
    await page.getByRole('checkbox', { name: 'Remember me' }).check();
  });
});
