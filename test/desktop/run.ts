// The desktop gate runner (spec vpa-001 §2.12, §4 Phase 2 parts E, F, G, H.1–H.2). It drives
// the gate build (`npm run tauri:gate`) through the in-page agent, test/desktop/agent.js.
//
//   caffeinate -dimu npm run test:desktop -- <suite> [n]
//
// Suites: launches [20] (E.1) · probe (E.2) · paths (E.3) · big [50] (E.4) · log (E.5)
//         gates [27] (F) · stale [50] (G) · openwith-cold [5] (H.1) · openwith-running [5] (H.2)
// Results: test-results/desktop-<suite>.json. The app window must stay visible.
// A stuck seek (no `seeked` 15 s after `seeking`) aborts any suite, with its stream.log lines.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { gateA, gateB, gateCb, gateCc, HELPERS, STALE_WORDING, type Driver, type Fixture } from '../e2e/gate';
import { channel, type Hello } from './channel';

const ROOT = resolve(import.meta.dirname, '../..');
const APP = resolve(ROOT, 'src-tauri/target-gate/release/bundle/macos/Video Player Assimilator.app');
const BIN = join(APP, 'Contents/MacOS/video-player-assimilator');
const LOG = join(homedir(), 'Library/Logs/com.ivapo.video-player-assimilator/stream.log');
const BIG = process.env.BIG_FIXTURE ?? join(homedir(), 'Movies/vpa-big.mp4');
const WORK = resolve(ROOT, 'test-results/desktop-work');
const PORT = 5181;
const FIX = (f: string) => resolve(ROOT, 'test/fixtures', f);

const [suite, nArg] = process.argv.slice(2);
const out: Record<string, unknown> = { suite, startedAt: new Date().toISOString() };
const save = () => {
  mkdirSync(resolve(ROOT, 'test-results'), { recursive: true });
  writeFileSync(resolve(ROOT, `test-results/desktop-${suite}.json`), JSON.stringify(out, null, 1));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withTimeout = <T,>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, sleep(ms).then(() => { throw new Error('timeout: ' + what); })]) as Promise<T>;
const logSize = () => (existsSync(LOG) ? statSync(LOG).size : 0);

// --- the channel, and the two checks that abort a run ------------------------------------

const hellos: Hello[] = [];
channel.onHello = (h) => {
  hellos.push(h);
  // Spike 1's "app" numbers were mostly a leftover Safari tab's: refuse any other page.
  if (h.protocol !== 'tauri:' || !h.tauri) abort(2, `hello from a page that is not the app's: ${JSON.stringify(h)}`);
};
channel.onStuck = (report: any) => {
  const lines = logLines().filter((l) => l.ms >= report.start - 1000 && l.ms <= report.start + 17000).map((l) => l.raw);
  const stuck = { report, streamLog: lines };
  out.stuck = stuck;
  const file = resolve(ROOT, `test-results/desktop-stuck-${Date.now()}.json`);
  mkdirSync(resolve(ROOT, 'test-results'), { recursive: true });
  writeFileSync(file, JSON.stringify(stuck, null, 1));
  abort(3, `STUCK SEEK (OQ-8): ${JSON.stringify(report)}\n${lines.length} stream.log lines, in ${file}:\n${lines.join('\n')}`);
};
function abort(code: number, msg: string): never {
  console.error(msg);
  out.aborted = msg;
  out.finishedAt = new Date().toISOString();
  save();
  quit();
  process.exit(code);
}

const server = createServer((req, res) => channel.handle(req, res));
await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));

const run = <T = unknown>(body: string, timeout?: number) => channel.send(body, timeout) as Promise<T>;

// --- the app ------------------------------------------------------------------------------

let child: ChildProcess | undefined;
async function launch(): Promise<number> {
  if (!existsSync(BIN)) throw new Error(`no gate build at ${APP}: run npm run tauri:gate`);
  const hello = channel.nextHello();
  const t0 = Date.now();
  child = spawn(BIN, [], { stdio: 'ignore' });
  await withTimeout(hello, 20000, 'app hello');
  return Date.now() - t0;
}
function quit() {
  const c = child;
  child = undefined;
  if (c && c.exitCode === null) c.kill('SIGKILL');
  pkillApp();
}
function pkillApp() {
  try { execFileSync('pkill', ['-9', '-f', 'Video Player Assimilator.app/Contents/MacOS/'], { stdio: 'ignore' }); } catch {}
}
function appPids(): number[] {
  try {
    return execFileSync('pgrep', ['-f', 'Video Player Assimilator.app/Contents/MacOS/']).toString().split('\n').filter(Boolean).map(Number);
  } catch { return []; }
}
const env = () => run<{ href: string; vis: string; focus: boolean; inner: string }>(
  `return { href: location.href, vis: document.visibilityState, focus: document.hasFocus(), inner: innerWidth + 'x' + innerHeight }`);
async function assertVisible() {
  const e = await env();
  if (e.vis !== 'visible') abort(4, `the app's page is ${e.vis}: the gate needs the window visible (caffeinate -dimu)`);
  return e;
}

// --- loading a file (§2.12 Driver.load) ------------------------------------------------

/** Reload the page and wait for the new page's hello. */
async function reload() {
  const hello = channel.nextHello();
  // The reload can cut off the agent's answer to this command, so only the new page's hello
  // is awaited; the answer, if it never comes, times out harmlessly.
  channel.send(`setTimeout(() => location.reload(), 50); return null`, 20000).catch(() => {});
  await withTimeout(hello, 15000, 'page hello after reload');
}

/** gate_open(path), then wait until the player has loaded it (readyState >= 2). */
async function openAndWait(path: string, timeout = 15000) {
  await run(`const path = ${JSON.stringify(path)};
    const url = window.__TAURI_INTERNALS__.convertFileSrc(path, 'stream');
    await window.__TAURI_INTERNALS__.invoke('gate_open', { path });
    const v = document.getElementById('video');
    await G.waitFor(() => {
      if (v.getAttribute('src') === url && v.error) throw new Error('media error ' + v.error.code + ' ' + v.error.message + ' for ' + path);
      return v.getAttribute('src') === url && v.readyState >= 2;
    }, 'load of ' + path, ${timeout});`, timeout + 5000);
}

async function load(path: string, { reloadFirst = true } = {}) {
  if (reloadFirst) await reload();
  await run(HELPERS);
  await openAndWait(path);
}

/**
 * After a failure: a seek still waiting for `seeked` is a stuck seek (OQ-8), whether or not
 * the agent's own watchdog has reported it yet. Wait until it is 15 s old; abort if still open.
 */
async function checkOpenSeek() {
  let open: any;
  try { open = await run<any>(`return window.__vpa.seeks.find((s) => s.end === null) ?? null`, 10000); } catch { return; }
  if (!open) return;
  const wait = open.start + 15500 - Date.now();
  if (wait > 0) await sleep(wait);
  const still = await run<boolean>(`return window.__vpa.seeks.some((s) => s.start === ${open.start} && s.end === null)`, 10000);
  if (still) channel.onStuck({ ...open, now: Date.now(), foundBy: 'runner after a failed step' });
}

const lastLoad = () => run<any>(`return window.__vpa.loads.at(-1)`);

/** Reads of the gate, tallied from settleRead's answers (F records stale reads per part). */
const tally = { reads: 0, staleFlagged: 0, staleWrong: 0 };
let expectK: number | null = null;
const drv: Driver = {
  browser: 'app',
  load: (fixture: Fixture) => load(FIX(fixture)),
  async run(body) {
    const m = /^return G\.settleRead\((\d+),/.exec(body);
    const v = await run<any>(body);
    if (m) {
      expectK = Number(m[1]);
      tally.reads++;
      if (v.stale) tally.staleFlagged++;
      if (v.stale && v.frame !== expectK) tally.staleWrong++;
    }
    return v;
  },
  key: (k) => run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)} }))`),
};

// --- stream.log -------------------------------------------------------------------------

interface LogLine { ms: number; method: string; range: string; status: number; cr: string; bytes: number; us: number; path: string; raw: string; panic: boolean }
function logLines(from = 0, to = Infinity): LogLine[] {
  if (!existsSync(LOG)) return [];
  const buf = readFileSync(LOG);
  const text = buf.subarray(from, Math.min(to, buf.length)).toString('utf8');
  const rows: LogLine[] = [];
  for (const raw of text.split('\n').filter(Boolean)) {
    const m = /^(\d+) (\S+) range=(.*?) -> (\d+) cr=(.+?) (\d+)B (\d+)us path=(.*)$/.exec(raw);
    if (m) rows.push({ ms: +m[1], method: m[2], range: m[3], status: +m[4], cr: m[5], bytes: +m[6], us: +m[7], path: m[8], raw, panic: false });
    else rows.push({ ms: Number(raw.split(' ')[0]), method: '', range: '', status: 0, cr: '', bytes: 0, us: 0, path: '', raw, panic: / PANIC /.test(raw) });
  }
  return rows;
}

// --- helpers ------------------------------------------------------------------------------

const stat = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1);
  return { n: s.length, min: +s[0].toFixed(1), median: q(0.5), p95: q(0.95), p99: q(0.99), max: +s.at(-1)!.toFixed(1) };
};
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error('[desktop] ' + msg);
}
const logStart = logSize();
out.log = { file: LOG, from: logStart };

// --- suites -------------------------------------------------------------------------------

const suites: Record<string, () => Promise<void>> = {
  launches, probe, paths, big, log: logCheck, gates, stale, 'openwith-cold': openwithCold, 'openwith-running': openwithRunning,
};
if (!suites[suite]) {
  console.error(`usage: npm run test:desktop -- <${Object.keys(suites).join('|')}> [n]`);
  process.exit(1);
}
let failed = false;
try {
  pkillApp();
  await suites[suite]();
} catch (e) {
  failed = true;
  out.error = String((e as Error).stack ?? e);
  console.error('FAIL', (e as Error).message);
} finally {
  (out.log as any).to = logSize();
  out.finishedAt = new Date().toISOString();
  save();
  quit();
  server.close();
}
process.exit(failed ? 1 : 0);

/** E.1: n cold launches, each loading frames.mp4 through gate_open. */
async function launches() {
  const n = Number(nArg ?? 20);
  const rows: any[] = [];
  out.rows = rows;
  for (let i = 0; i < n; i++) {
    try {
      const helloMs = await launch();
      const e = await assertVisible();
      await load(FIX('frames.mp4'), { reloadFirst: false });
      await run(`await G.waitFor(() => window.__vpa.loads.at(-1).firstFrame !== undefined, 'first frame', 5000)`);
      const l = await lastLoad();
      const row = { i, ok: true, helloMs, env: e, firstFrameMs: l.firstFrame - l.srcSet, metadataMs: l.loadedmetadata - l.srcSet };
      rows.push(row);
      console.log(i, 'OK  ', JSON.stringify(row));
    } catch (e) {
      rows.push({ i, ok: false, error: String((e as Error).message).slice(0, 400) });
      console.log(i, 'FAIL', String((e as Error).message).slice(0, 300));
    }
    quit();
    await sleep(500);
    save();
  }
  const ok = rows.filter((r) => r.ok);
  out.summary = { launches: n, ok: ok.length, firstFrameMs: stat(ok.map((r) => r.firstFrameMs)) };
  console.log('SUMMARY', JSON.stringify(out.summary));
  check(ok.length === n, `E.1: ${ok.length}/${n} launches loaded`);
}

/** E.2: the scheme's answers, fetched from the app's page. */
async function probe() {
  check(existsSync(BIG), `E.2 needs the large file at ${BIG}: run scripts/make-big-fixture.sh`);
  mkdirSync(WORK, { recursive: true });
  const frames = FIX('frames.mp4');
  const gone = join(WORK, 'probe deleted.mp4');
  copyFileSync(frames, gone);
  const never = FIX('frames120.mp4'); // exists, never opened in this process
  const bigLen = statSync(BIG).size;
  const fileBytes = readFileSync(frames);
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

  await launch();
  out.env = await assertVisible();
  await load(gone, { reloadFirst: false });
  await openAndWait(BIG, 30000);
  await openAndWait(frames);
  rmSync(gone);

  const res = await run<any[]>(`
    const conv = (p) => window.__TAURI_INTERNALS__.convertFileSrc(p, 'stream');
    const hex = async (b) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
    const cases = ${JSON.stringify([
      { id: 'a-b', path: frames, range: 'bytes=0-99' },
      { id: 'a-', path: frames, range: 'bytes=100-' },
      { id: '-n', path: frames, range: 'bytes=-100' },
      { id: 'bad', path: frames, range: 'bytes=abc' },
      { id: 'out-of-range', path: frames, range: 'bytes=60000-' },
      { id: 'multi', path: frames, range: 'bytes=0-9,20-29' },
      { id: 'head', path: frames, method: 'HEAD' },
      { id: 'big 0-2097151', path: BIG, range: 'bytes=0-2097151' },
      { id: 'big 0-', path: BIG, range: 'bytes=0-' },
      { id: 'big no range', path: BIG },
      { id: 'never opened', path: never, range: 'bytes=0-99' },
      { id: 'opened, deleted', path: gone, range: 'bytes=0-99' },
    ])};
    const out = [];
    for (const c of cases) {
      try {
        const r = await fetch(conv(c.path), { method: c.method ?? 'GET', headers: c.range ? { Range: c.range } : {} });
        const b = await r.arrayBuffer();
        out.push({ ...c, status: r.status, type: r.type, contentRange: r.headers.get('content-range'),
          contentLength: r.headers.get('content-length'), bytes: b.byteLength, sha: await hex(b), t: Date.now() });
      } catch (e) { out.push({ ...c, error: String(e) }); }
    }
    return out;`);
  const expect: Record<string, { status: number; cr?: string; slice?: [number, number]; bytes?: number; len?: string }> = {
    'a-b': { status: 206, cr: 'bytes 0-99/52036', slice: [0, 99] },
    'a-': { status: 206, cr: 'bytes 100-52035/52036', slice: [100, 52035] },
    '-n': { status: 206, cr: 'bytes 51936-52035/52036', slice: [51936, 52035] },
    bad: { status: 416, cr: 'bytes */52036', bytes: 0 },
    'out-of-range': { status: 416, cr: 'bytes */52036', bytes: 0 },
    multi: { status: 416, cr: 'bytes */52036', bytes: 0 },
    head: { status: 200, len: '52036', bytes: 0 },
    'big 0-2097151': { status: 206, cr: `bytes 0-1048575/${bigLen}`, bytes: 1048576 },
    'big 0-': { status: 206, cr: `bytes 0-1048575/${bigLen}`, bytes: 1048576 },
    'big no range': { status: 206, cr: `bytes 0-1048575/${bigLen}`, bytes: 1048576 },
    'never opened': { status: 403, bytes: 0 },
    'opened, deleted': { status: 404, bytes: 0 },
  };
  check(fileBytes.length === 52036, `frames.mp4 is ${fileBytes.length} bytes, not 52 036`);
  const rows = res.map((r) => {
    const e = expect[r.id];
    const fails: string[] = [];
    if (r.error) fails.push(`fetch failed (no CORS header?): ${r.error}`);
    else {
      if (r.status !== e.status) fails.push(`status ${r.status} ≠ ${e.status}`);
      if (e.cr !== undefined && r.contentRange !== e.cr) fails.push(`Content-Range ${r.contentRange} ≠ ${e.cr}`);
      if (e.bytes !== undefined && r.bytes !== e.bytes) fails.push(`${r.bytes} bytes ≠ ${e.bytes}`);
      if (e.len !== undefined && r.contentLength !== e.len) fails.push(`Content-Length ${r.contentLength} ≠ ${e.len}`);
      if (e.slice && r.sha !== sha(fileBytes.subarray(e.slice[0], e.slice[1] + 1))) fails.push('wrong bytes');
    }
    return { ...r, expected: e, pass: fails.length === 0, fails };
  });
  out.rows = rows;
  for (const r of rows) console.log(r.pass ? 'OK  ' : 'FAIL', r.id.padEnd(16), r.status, r.contentRange ?? '', r.bytes, r.fails.join('; '));
  out.summary = { probes: rows.length, pass: rows.filter((r) => r.pass).length };
  console.log('SUMMARY', JSON.stringify(out.summary));
  check(rows.every((r) => r.pass), 'E.2: a probe failed');
}

/** E.3 (amended at the build): six awkward names in a directory named with spaces and Unicode. */
async function paths() {
  const dir = join(WORK, 'dir with spaces & ünïcødé 視頻');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const names = [
    'a b  c (1).mp4',
    'this & that.mp4',
    'é NFD, é NFC.mp4',
    'видео 日本語 😀.mp4',
    'percent%20hash#q?.mp4',
    'L'.repeat(246) + '.mp4',
  ];
  for (const n of names) copyFileSync(FIX('frames.mp4'), join(dir, n));
  await launch();
  out.env = await assertVisible();
  const rows: any[] = [];
  out.rows = rows;
  for (const name of names) {
    const path = join(dir, name);
    try {
      await load(path);
      // E.3 as amended at the build: play until d snaps, pause, seek, and read under the
      // app's rule, so that a stale picture is warned (before d is known it cannot be).
      await drv.key(' ');
      await run(`await G.waitFor(() => G.data().dSnapped === 'true' || G.data().ended, 'snap', 5000)`);
      await drv.key(' ');
      await run(`await G.waitFor(() => G.data().paused && G.data().pending === 'false', 'pause and snap')`);
      const r = await run<{ frame: number; stale: boolean; text: string }>(`await G.seek(10.5 / 30); return G.settleRead(10, 30);`);
      const ruleOk = r.frame === 10 ? !r.stale : r.stale && r.text.includes(STALE_WORDING);
      rows.push({ name, nameBytes: Buffer.byteLength(name), pathBytes: Buffer.byteLength(path), ok: ruleOk, frame: r.frame, stale: r.stale });
    } catch (e) {
      rows.push({ name, ok: false, error: String((e as Error).message).slice(0, 300) });
    }
    const r = rows.at(-1);
    console.log(r.ok ? 'OK  ' : 'FAIL', r.nameBytes, JSON.stringify(name).slice(0, 50), r.frame ?? r.error);
  }
  out.summary = { paths: names.length, ok: rows.filter((r) => r.ok).length, frame10: rows.filter((r) => r.frame === 10).length, staleWarned: rows.filter((r) => r.ok && r.stale).length };
  console.log('SUMMARY', JSON.stringify(out.summary));
  check(rows.every((r) => r.ok), 'E.3: a path failed');
}

/** The app's WebKit XPC processes. */
function webkitPids(): Set<number> {
  const ps = execFileSync('ps', ['-axo', 'pid=,comm=']).toString();
  return new Set(ps.split('\n').filter((l) => /com\.apple\.WebKit\./.test(l)).map((l) => Number(l.trim().split(/\s+/)[0])));
}
function rss(pids: number[]): Record<string, number> {
  if (!pids.length) return {};
  let ps = '';
  try { ps = execFileSync('ps', ['-o', 'pid=,rss=,comm=', '-p', pids.join(',')]).toString(); } catch { return {}; }
  const r: Record<string, number> = {};
  for (const l of ps.split('\n').filter(Boolean)) {
    const [pid, kb, ...c] = l.trim().split(/\s+/);
    const name = c.join(' ').split('/').pop()!.replace('com.apple.WebKit.', '');
    r[`${name}:${pid}`] = Math.round(Number(kb) / 1024);
  }
  return r;
}

/** E.4: the 1 GB file: first frame, n random paused seeks, peak RSS. */
async function big() {
  const n = Number(nArg ?? 50);
  check(existsSync(BIG), `no large file at ${BIG}: run scripts/make-big-fixture.sh`);
  const size = statSync(BIG).size;
  check(size > 1e9, `the large file is ${size} bytes, not over 10^9`);
  const before = webkitPids();
  await launch();
  out.env = await assertVisible();
  const appPid = child!.pid!;
  const mine = () => [appPid, ...[...webkitPids()].filter((p) => !before.has(p))];
  const peak: Record<string, number> = {};
  const sampler = setInterval(() => {
    for (const [k, v] of Object.entries(rss(mine()))) peak[k] = Math.max(peak[k] ?? 0, v);
  }, 200);
  try {
    await load(BIG, { reloadFirst: false });
    await run(`await G.waitFor(() => window.__vpa.loads.at(-1).firstFrame !== undefined, 'first frame', 10000)`);
    const l = await lastLoad();
    out.load = { bytes: size, metadataMs: l.loadedmetadata - l.srcSet, firstFrameMs: l.firstFrame - l.srcSet };
    console.log('load', JSON.stringify(out.load));
    const seeks = await run<any[]>(`const v = document.getElementById('video'); const res = [];
      let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
      for (let i = 0; i < ${n}; i++) {
        const target = rnd() * (v.duration - 1);
        let shown = null;
        const cb = (now, m) => { if (Math.abs(m.mediaTime - target) < 0.1) shown = performance.now(); else v.requestVideoFrameCallback(cb); };
        v.requestVideoFrameCallback(cb);
        const t0 = performance.now();
        await new Promise((r) => { v.addEventListener('seeked', r, { once: true }); v.currentTime = target; });
        const seeked = performance.now() - t0;
        const t1 = performance.now();
        while (shown === null && performance.now() - t1 < 2000) await G.sleep(2);
        res.push({ target, seeked, frame: shown === null ? null : shown - t0 });
        await G.sleep(50);
      }
      return res;`, 600000);
    // 5 s of playback from the middle as well: a steady read, not only seeks.
    await run(`const v = document.getElementById('video'); v.currentTime = v.duration / 2;
      await new Promise((r) => v.addEventListener('seeked', r, { once: true })); await v.play(); await G.sleep(5000); v.pause();`);
    out.seeks = seeks;
    out.seekStats = {
      seeked: stat(seeks.map((s) => s.seeked)),
      frameShown: stat(seeks.filter((s) => s.frame !== null).map((s) => s.frame)),
      shownWithin2s: seeks.filter((s) => s.frame !== null).length,
    };
    console.log('seeks', JSON.stringify(out.seekStats));
  } finally {
    clearInterval(sampler);
    out.peakRssMB = peak;
    console.log('peak RSS MB', JSON.stringify(peak));
  }
  const appPeak = peak[Object.keys(peak).find((k) => k.endsWith(':' + appPid))!] ?? NaN;
  out.summary = { shownWithin2s: (out.seekStats as any).shownWithin2s, of: n, appPeakRssMB: appPeak };
  console.log('SUMMARY', JSON.stringify(out.summary));
  check((out.seekStats as any).shownWithin2s === n, `E.4: ${(out.seekStats as any).shownWithin2s}/${n} seeks showed a frame within 2 s`);
  check(appPeak < 300, `E.4: the app's peak RSS is ${appPeak} MB, not under 300`);
}

/** E.5: stream.log over the E.1–E.4 runs (read from their result files). */
async function logCheck() {
  const res = (s: string) => JSON.parse(readFileSync(resolve(ROOT, `test-results/desktop-${s}.json`), 'utf8'));
  const parts = ['launches', 'probe', 'paths', 'big'].map((s) => ({ s, r: res(s) }));
  const rows: any = {};
  let ok = true;
  for (const { s, r } of parts) {
    const lines = logLines(r.log.from, r.log.to);
    const panics = lines.filter((l) => l.panic);
    const parsed = lines.filter((l) => l.status);
    rows[s] = { lines: lines.length, panics: panics.length, statuses: countBy(parsed.map((l) => l.status)), handlerUs: stat(parsed.map((l) => l.us)) };
    if (panics.length) ok = false;
    if (s === 'launches') {
      // Each launch loads frames.mp4: a 206 line for it, per launch.
      const loads = parsed.filter((l) => l.path === FIX('frames.mp4') && l.status === 206).length;
      rows[s].frames206 = loads;
      if (loads < r.summary.launches) ok = false;
    }
    if (s === 'probe') {
      rows[s].probes = r.rows.map((p: any) => {
        const hit = parsed.find((l) => l.path === p.path && l.status === p.status && l.method === (p.method ?? 'GET') && l.range === (p.range ?? '-'));
        if (!hit) ok = false;
        return { id: p.id, status: p.status, line: hit?.raw ?? null };
      });
    }
    if (s === 'paths') {
      rows[s].perPath = r.rows.map((p: any) => {
        const hit = parsed.some((l) => l.path.endsWith(p.name) && l.status === 206);
        if (!hit) ok = false;
        return { name: p.name.slice(0, 40), logged: hit };
      });
    }
    if (s === 'big') {
      rows[s].big206 = parsed.filter((l) => l.path === BIG && l.status === 206).length;
      if (!rows[s].big206) ok = false;
    }
  }
  out.rows = rows;
  console.log(JSON.stringify(rows, null, 1));
  out.summary = { ok };
  check(ok, 'E.5: stream.log is missing a line, or has a panic');
}
function countBy(xs: number[]) {
  const m: Record<string, number> = {};
  for (const x of xs) m[x] = (m[x] ?? 0) + 1;
  return m;
}

/** F: Phase 1's gates A, B, C(b), C(c) in the app, n repetitions. */
async function gates() {
  const reps = Number(nArg ?? 27);
  await launch();
  out.env = await assertVisible();
  const rows: any[] = [];
  out.rows = rows;
  for (let rep = 0; rep < reps; rep++) {
    for (const [name, gate] of [['A', gateA], ['B', gateB], ['Cb', gateCb], ['Cc', gateCc]] as const) {
      const t0 = Date.now();
      const before = { ...tally };
      try {
        const result: any = await gate(drv);
        // C(c): frame callbacks over the whole clip, counted by the agent.
        if (name === 'Cc') result.callbacks = await run<number>(`return window.__vpa.loads.at(-1).callbacks`);
        const reads = { reads: tally.reads - before.reads, staleFlagged: tally.staleFlagged - before.staleFlagged, staleWrong: tally.staleWrong - before.staleWrong };
        rows.push({ rep, gate: name, pass: true, ms: Date.now() - t0, reads, result });
        console.log(rep, name, 'PASS', JSON.stringify(reads), JSON.stringify(result).slice(0, 140));
      } catch (e) {
        rows.push({ rep, gate: name, pass: false, ms: Date.now() - t0, error: String((e as Error).message).slice(0, 800) });
        console.log(rep, name, 'FAIL', String((e as Error).message).slice(0, 400));
        save();
        await checkOpenSeek();
      }
      save();
    }
    if (rep % 5 === 4) await assertVisible();
  }
  const cc = rows.filter((r) => r.gate === 'Cc' && r.pass).map((r) => r.result);
  out.summary = {
    runs: rows.length,
    pass: rows.filter((r) => r.pass).length,
    failed: rows.filter((r) => !r.pass).map((r) => `${r.rep}${r.gate}`),
    reads: tally,
    cc: { batched: cc.filter((r) => r.counter === 'batched').length, outcomes: countByStr(cc.map((r) => r.outcome)), callbacks: stat(cc.map((r) => r.callbacks)) },
  };
  console.log('SUMMARY', JSON.stringify(out.summary));
  check(rows.every((r) => r.pass), `F: ${rows.filter((r) => !r.pass).length} gate runs failed`);
}
function countByStr(xs: string[]) {
  const m: Record<string, number> = {};
  for (const x of xs) m[x] = (m[x] ?? 0) + 1;
  return m;
}

/** G: the C(b) sequence, then a paused seek to 100.5/60; pixels at 300 ms and 2 s after `seeked`. */
async function stale() {
  const n = Number(nArg ?? 50);
  await launch();
  out.env = await assertVisible();
  const rows: any[] = [];
  out.rows = rows;
  for (let i = 0; i < n; i++) {
    try {
      await drv.load('frames60ms.mp4');
      await drv.key(' ');
      await run(`await G.waitFor(() => G.data().currentTime >= 0.5, 'play 0.5 s');
        const s = document.getElementById('seek'); s.value = '0'; s.dispatchEvent(new Event('input', { bubbles: true }));
        await G.waitFor(() => G.data().dSnapped === 'true' || G.data().ended, 'snap', 10000);`);
      await drv.key(' ');
      const r = await run<any>(`
        await G.waitFor(() => G.data().paused && G.data().pending === 'false', 'pause and snap');
        const dMs = G.data().dMs;
        await G.seek(100.5 / 60);
        const t0 = performance.now();
        const shows = () => G.presented !== null && Math.round(G.presented * 60) === 100;
        let firstShowMs = shows() ? 0 : null;
        const marks = {};
        for (const at of [100, 300, 2000]) {
          while (performance.now() - t0 < at) { await G.sleep(2); if (firstShowMs === null && shows()) firstShowMs = performance.now() - t0; }
          const d = G.data();
          marks[at] = { pixel: G.readFrame(), warn: d.stale === 'true', frame: d.frame, text: d.text };
        }
        return { dMs, firstShowMs, marks, vis: document.visibilityState, focus: document.hasFocus() };`);
      const m = r.marks;
      const row = {
        i, dMs: r.dMs, firstShowMs: r.firstShowMs, vis: r.vis, focus: r.focus,
        px: [m[100].pixel, m[300].pixel, m[2000].pixel], k300: m[300].frame,
        stale300: m[300].pixel !== 100, stale2s: m[2000].pixel !== 100, warn300: m[300].warn, warn2s: m[2000].warn,
        wording: !m[300].warn || m[300].text.includes(STALE_WORDING),
      };
      rows.push(row);
      console.log(i, row.stale300 ? 'STALE' : 'ok   ', JSON.stringify(row));
    } catch (e) {
      rows.push({ i, error: String((e as Error).message).slice(0, 400) });
      console.log(i, 'ERROR', String((e as Error).message).slice(0, 300));
      save();
      await checkOpenSeek();
    }
    if (i % 10 === 9) save();
  }
  const ok = rows.filter((r) => !r.error);
  out.summary = {
    runs: ok.length,
    errors: rows.length - ok.length,
    stale300: ok.filter((r) => r.stale300).length,
    healedBy2s: ok.filter((r) => r.stale300 && !r.stale2s).length,
    warnInStale: ok.filter((r) => r.stale300 && r.warn300).length,
    warnInCorrect: ok.filter((r) => !r.stale300 && r.warn300).length,
    staleWithoutWarn: ok.filter((r) => r.stale300 && !r.warn300).length,
    wrongWording: ok.filter((r) => !r.wording).length,
    seekedToTargetMs: stat(ok.filter((r) => !r.stale300 && r.firstShowMs !== null).map((r) => r.firstShowMs)),
  };
  console.log('SUMMARY', JSON.stringify(out.summary));
  const s = out.summary as any;
  check(s.warnInCorrect === 0 && s.staleWithoutWarn === 0 && s.wrongWording === 0, 'G: the warning is not exact');
  check(s.errors === 0, `G: ${s.errors} runs errored`);
}

// --- H.1–H.2: "Open with" through LaunchServices (the gate build, registered) ---------------

function openWith(file?: string) {
  execFileSync('open', ['-a', APP, ...(file ? [file] : [])]);
}

/** Play until d snaps, then assert it is exactly 1/fps (as gate.ts does). */
async function playToSnap(fps: number) {
  await drv.key(' ');
  await run(`await G.waitFor(() => G.data().dSnapped === 'true' || G.data().ended, 'snap', 10000)`);
  const d = await run<any>(`return G.data()`);
  check(d.dSnapped === 'true' && Number(d.dMs) === (1 / fps) * 1000, `d did not snap to exactly 1/${fps}: ${d.dMs} (${d.status})`);
  await drv.key(' ');
  return d.dMs as string;
}

/** Wait until the page has loaded `path` (arrived by "Open with"), and return that load. */
async function waitOpened(path: string) {
  await run(`const url = window.__TAURI_INTERNALS__.convertFileSrc(${JSON.stringify(path)}, 'stream');
    const v = document.getElementById('video');
    await G.waitFor(() => v.getAttribute('src') === url && v.readyState >= 2 && window.__vpa.loads.at(-1)?.firstFrame !== undefined, 'opened file', 15000);`);
  return run<any>(`return { load: window.__vpa.loads.at(-1), timeOrigin: window.__vpa.timeOrigin, name: document.getElementById('name').textContent }`);
}

/** H.1: cold start, `open -a <app> frames60ms.mp4`. */
async function openwithCold() {
  const n = Number(nArg ?? 5);
  const rows: any[] = [];
  out.rows = rows;
  for (let i = 0; i < n; i++) {
    pkillApp();
    await sleep(1000);
    try {
      const hello = channel.nextHello();
      const t0 = Date.now();
      openWith(FIX('frames60ms.mp4'));
      await withTimeout(hello, 20000, 'app hello');
      const e = await assertVisible();
      await run(HELPERS);
      const o = await waitOpened(FIX('frames60ms.mp4'));
      const firstFrameEpoch = o.timeOrigin + o.load.firstFrame;
      const dMs = await playToSnap(60);
      const row = { i, ok: true, openToFirstFrameMs: firstFrameEpoch - t0, name: o.name, dMs, env: e, pids: appPids().length };
      rows.push(row);
      console.log(i, 'OK  ', JSON.stringify(row));
    } catch (e) {
      rows.push({ i, ok: false, error: String((e as Error).message).slice(0, 400) });
      console.log(i, 'FAIL', String((e as Error).message).slice(0, 300));
    }
    save();
  }
  pkillApp();
  const ok = rows.filter((r) => r.ok);
  out.summary = { runs: n, ok: ok.length, openToFirstFrameMs: stat(ok.map((r) => r.openToFirstFrameMs)) };
  console.log('SUMMARY', JSON.stringify(out.summary));
  check(ok.length === n, `H.1: ${ok.length}/${n}`);
}

/** H.2: the app running with frames.mp4 loaded and snapped; `open -a <app> frames60ms.mp4`. */
async function openwithRunning() {
  const n = Number(nArg ?? 5);
  const rows: any[] = [];
  out.rows = rows;
  for (let i = 0; i < n; i++) {
    pkillApp();
    await sleep(1000);
    try {
      const hello = channel.nextHello();
      openWith();
      await withTimeout(hello, 20000, 'app hello');
      const e = await assertVisible();
      await run(HELPERS);
      await openAndWait(FIX('frames.mp4'));
      await playToSnap(30);
      const pidsBefore = appPids();
      check(pidsBefore.length === 1, `expected one app process, found ${pidsBefore.length}`);
      const t0 = Date.now();
      openWith(FIX('frames60ms.mp4'));
      const o = await waitOpened(FIX('frames60ms.mp4'));
      const firstFrameEpoch = o.timeOrigin + o.load.firstFrame;
      const reset = await run<any>(`return G.data()`);
      const pidsAfter = appPids();
      check(pidsAfter.length === 1 && pidsAfter[0] === pidsBefore[0], `process changed: ${pidsBefore} → ${pidsAfter}`);
      check(reset.stepDisabled && reset.status === 'measuring' && reset.text.includes('measuring frame rate…'),
        `readout did not reset: ${JSON.stringify(reset)}`);
      const dMs = await playToSnap(60);
      const row = { i, ok: true, pid: pidsAfter[0], openToFirstFrameMs: firstFrameEpoch - t0, name: o.name, dMs, env: e };
      rows.push(row);
      console.log(i, 'OK  ', JSON.stringify(row));
    } catch (e) {
      rows.push({ i, ok: false, error: String((e as Error).message).slice(0, 400) });
      console.log(i, 'FAIL', String((e as Error).message).slice(0, 300));
    }
    save();
  }
  pkillApp();
  const ok = rows.filter((r) => r.ok);
  out.summary = { runs: n, ok: ok.length, openToFirstFrameMs: stat(ok.map((r) => r.openToFirstFrameMs)) };
  console.log('SUMMARY', JSON.stringify(out.summary));
  check(ok.length === n, `H.2: ${ok.length}/${n}`);
}
