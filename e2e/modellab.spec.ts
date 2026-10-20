import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';

// Fake OpenAI-compatible endpoint: the first answer has a runtime bug, the repair answer works.
const BROKEN = 'Here is my program.\n```js\nexport default function control(obs, mem) {\n  return { thrust: obs.self.missing.x, turn: 0, fire: false };\n}\n```';
const FIXED = '```javascript\nexport default function control(obs, mem) {\n  const e = obs.enemies.find((x) => x.alive);\n  if (!e) return { thrust: 0, turn: 0, fire: false };\n  const a = obs.lib.angleTo(obs.self.pos, e.pos);\n  const err = obs.lib.wrapAngle(a - obs.self.angle);\n  return { thrust: 0, turn: Math.max(-1, Math.min(1, err * 3)), fire: Math.abs(err) < 0.05 };\n}\n```';

let server: Server;
const requests: any[] = [];

test.beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    if (req.method === 'OPTIONS') return res.end();
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fake-coder' }] }));
      const j = JSON.parse(body);
      requests.push(j);
      const text = j.messages.length <= 2 ? BROKEN : FIXED;
      res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }));
    });
  });
  await new Promise<void>((r) => server.listen(5299, r));
});

test.afterAll(() => server.close());

test('model lab generates a strategy, repairs it once and saves it', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'MODEL LAB' }).click();
  await page.getByPlaceholder('nome', { exact: true }).fill('fake');
  await page.getByPlaceholder('base URL').fill('http://localhost:5299/v1');
  await page.getByRole('button', { name: '+ adicionar' }).click();
  await page.getByRole('button', { name: '/models' }).click();
  await expect(page.locator('.term')).toContainText('fake: 1 modelos');

  const modelRow = page.locator('.panel', { has: page.locator('.panel-title', { hasText: 'modelos' }) });
  await modelRow.locator('select').selectOption({ label: 'fake' });
  await modelRow.getByPlaceholder('id do modelo').fill('fake-coder');
  await modelRow.getByPlaceholder('rótulo').fill('fake-coder');
  await modelRow.getByRole('button', { name: '+ modelo' }).click();
  await modelRow.locator('input[type=checkbox]').check();

  await page.getByRole('button', { name: /▶ gerar \(1\)/ }).click();
  await expect(page.locator('.term')).toContainText('salva como fake-coder@v1', { timeout: 30_000 });
  await expect(page.locator('.term')).toContainText('1 reparo(s)');
  expect(requests.length).toBe(2);
  // Same system prompt both times; the repair message carries the validation report.
  expect(requests[1].messages[0]).toEqual(requests[0].messages[0]);
  expect(requests[1].messages.at(-1).content).toContain('TypeError');
  expect(requests[0].temperature).toBe(0.2);

  await expect(page.locator('td', { hasText: 'fake-coder@v1' })).toBeVisible();
  await page.screenshot({ path: '.tmp/playwright/modellab.png', fullPage: true });
});
