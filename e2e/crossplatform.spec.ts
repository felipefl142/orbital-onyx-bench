import { expect, test } from '@playwright/test';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// Replays recorded by the Node CLI must re-simulate to the same final hash in the browser.
test('node replays verify in the browser (1v1 and FFA with orbits)', async ({ page }) => {
  mkdirSync('.tmp/xplat', { recursive: true });
  execSync('npx tsx cli/bench.ts --seeds 1 --planets 6 --orbits --resamples 10 --out .tmp/xplat/r1.json --save-replay 3:.tmp/xplat/1v1.json', { stdio: 'pipe' });
  execSync('npx tsx cli/bench.ts --format ffa --ffa-size 4 --seeds 1 --planets 10 --orbits --resamples 10 --out .tmp/xplat/r2.json --save-replay 2:.tmp/xplat/ffa.json', { stdio: 'pipe' });

  await page.goto('/');
  await page.getByRole('button', { name: 'REPLAYS' }).click();
  for (const f of ['1v1', 'ffa']) {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '⤒ importar' }).click();
    await (await chooser).setFiles(`.tmp/xplat/${f}.json`);
    await expect(page.getByText('✓ replay importado')).toBeVisible();
  }
  const rows = page.locator('tbody tr', { hasText: '(importado)' });
  await expect(rows).toHaveCount(2);
  for (let i = 0; i < 2; i++) await rows.nth(i).getByRole('button', { name: 'verificar' }).click();
  await expect(rows.locator('td.ok', { hasText: '✓' })).toHaveCount(2, { timeout: 60_000 });
});

// Full live matches (strategies included) must end on the same state in Node and in the browser.
test('live reference matches hash the same in node and in the browser', async ({ page }) => {
  const node: string[] = JSON.parse(execSync('npx tsx cli/hashes.ts', { stdio: 'pipe' }).toString().trim().split('\n').pop()!);
  await page.goto('/');
  const browser: string[] = await page.evaluate(async () => {
    const m = await import('/src/bench/crosscheck.ts' as string);
    return m.crossEngineHashes();
  });
  expect(node.length).toBeGreaterThan(20);
  expect(browser).toEqual(node);
});
