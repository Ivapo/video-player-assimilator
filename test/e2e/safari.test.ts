// The gate in the real Safari.app, driven through safaridriver. safaridriver cannot set a
// file input, so the fixture loads through the dev-only `?src=` parameter against `vite dev`.
import { afterAll, beforeAll, test } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { remote } from 'webdriverio';
import { gateA, gateB, gateCb, gateCc, HELPERS, type Driver } from './gate';

const PORT = 5174;
const BASE = `http://localhost:${PORT}/video-player-assimilator/`;

let server: ViteDevServer;
let browser: WebdriverIO.Browser;
let drv: Driver;
const results: Record<string, unknown> = {};

beforeAll(async () => {
  server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' });
  await server.listen();
  browser = await remote({ capabilities: { browserName: 'safari' }, logLevel: 'warn' });
  await browser.setTimeout({ script: 120_000 });
  drv = {
    browser: 'safari',
    async load(fixture) {
      await browser.url(`${BASE}?src=${encodeURIComponent(`${BASE}test/fixtures/${fixture}`)}`);
      await browser.execute(HELPERS);
      await browser.waitUntil(() =>
        browser.execute(() => (document.getElementById('video') as HTMLVideoElement).readyState >= 2),
      );
    },
    run: (body) =>
      browser.execute(`return (async () => { const G = window.__gate; ${body} })()`) as never,
    key: (k) => browser.keys(k),
  };
});

afterAll(async () => {
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/gate-safari.json', JSON.stringify(results, null, 2));
  console.log('gate-safari', JSON.stringify(results));
  await browser?.deleteSession();
  await server?.close();
});

test('A — frames.mp4', async () => void (results.A = await gateA(drv)));
test('B — frames60ms.mp4', async () => void (results.B = await gateB(drv)));
test('C(b) — seek bar before d is known', async () => void (results.Cb = await gateCb(drv)));
test('C(c) — 120 fps on this display', async () => void (results.Cc = await gateCc(drv)));
