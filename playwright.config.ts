import { defineConfig } from '@playwright/test';

// Gate runner for installed Google Chrome (spec vpa-001 §2.6), against the production build.
// Headed: frame presentation and the display's refresh rate matter to the gate.
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: 'chrome.spec.ts',
  timeout: 120_000,
  workers: 1,
  reporter: 'list',
  use: {
    channel: 'chrome',
    headless: false,
    baseURL: 'http://localhost:4173/video-player-assimilator/',
  },
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173/video-player-assimilator/',
    reuseExistingServer: false,
  },
});
