// The gate in installed Google Chrome. The file arrives through the real file input.
import { test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gateA, gateB, gateCb, gateCc, HELPERS, type Driver } from './gate';

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));
const results: Record<string, unknown> = {};

function driver(page: Page): Driver {
  return {
    browser: 'chrome',
    async load(fixture) {
      await page.goto('./');
      await page.evaluate(HELPERS);
      await page.setInputFiles('#file', fixtures + fixture);
      await page.waitForFunction(() => (document.getElementById('video') as HTMLVideoElement).readyState >= 2);
    },
    run: (body) => page.evaluate(`(async () => { const G = window.__gate; ${body} })()`),
    key: (k) => page.keyboard.press(k === ' ' ? 'Space' : k),
  };
}

test.describe.configure({ mode: 'serial' });

test('A — frames.mp4', async ({ page }) => (results.A = await gateA(driver(page))));
test('B — frames60ms.mp4', async ({ page }) => (results.B = await gateB(driver(page))));
test('C(b) — seek bar before d is known', async ({ page }) => (results.Cb = await gateCb(driver(page))));
test('C(c) — 120 fps on this display', async ({ page }) => (results.Cc = await gateCc(driver(page))));

test.afterAll(() => {
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/gate-chrome.json', JSON.stringify(results, null, 2));
  console.log('gate-chrome', JSON.stringify(results));
});
