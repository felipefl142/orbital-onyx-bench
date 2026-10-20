import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  use: { baseURL: 'http://localhost:5199', ...devices['Desktop Firefox'], viewport: { width: 1440, height: 1000 } },
  projects: [{ name: 'firefox', use: { browserName: 'firefox' } }],
  webServer: { command: 'npx vite --port 5199 --strictPort', url: 'http://localhost:5199', reuseExistingServer: true },
  outputDir: '.tmp/playwright',
});
