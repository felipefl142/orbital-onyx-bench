import { expect, test } from '@playwright/test';

test('arena plays a full match and the replay re-simulates to the same hash', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto('/');
  await expect(page.getByLabel('Orbital Onyx')).toBeVisible();
  await page.getByRole('button', { name: '▶ nova partida' }).click();
  // Max speed, then wait for the result panel.
  for (let i = 0; i < 6; i++) await page.getByRole('button', { name: '+', exact: true }).click();
  await expect(page.locator('.panel-title', { hasText: 'resultado' })).toBeVisible({ timeout: 90_000 });
  await page.screenshot({ path: '.tmp/playwright/arena.png' });

  await page.getByRole('button', { name: '⤓ salvar replay' }).click();
  await page.getByRole('button', { name: 'REPLAYS' }).click();
  await page.getByRole('button', { name: 'verificar' }).first().click();
  await expect(page.locator('td.ok', { hasText: '✓' })).toBeVisible({ timeout: 60_000 });

  expect(errors).toEqual([]);
});

test('tournament with reference strategies ranks them', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'TORNEIO' }).click();
  const seeds = page.locator('label', { hasText: 'seeds' }).locator('input');
  await seeds.fill('1');
  await page.getByRole('button', { name: /▶ rodar \d+ partidas/ }).click();
  await expect(page.locator('.panel-title', { hasText: 'ranking' })).toBeVisible({ timeout: 90_000 });
  const chosen = await page.locator('.panel', { has: page.locator('.panel-title', { hasText: /^torneio$/ }) }).locator('input[type=checkbox]:checked').count();
  await expect(page.locator('table').first().locator('tbody tr')).toHaveCount(chosen);
  await expect(page.locator('table').first()).toContainText('hunter');
  await page.screenshot({ path: '.tmp/playwright/tournament.png', fullPage: true });
});
