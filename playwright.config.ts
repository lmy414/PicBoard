import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  use: { browserName: 'chromium', channel: 'msedge', headless: true, viewport: { width: 1000, height: 700 } },
  webServer: { command: 'npm run dev:renderer', url: 'http://127.0.0.1:5173/tests/browser/editor.html', reuseExistingServer: true },
  reporter: 'list',
});
