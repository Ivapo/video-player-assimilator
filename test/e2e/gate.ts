// The Phase 1 exit gate (spec vpa-001 §4, parts A, B, C(b), C(c)): one file of steps,
// shared by the Chrome runner (Playwright) and the Safari runner (safaridriver).
//
// Each gate returns a record of what it measured. A failed check throws.

export type Fixture = 'frames.mp4' | 'frames60ms.mp4' | 'frames120.mp4';

export interface Driver {
  readonly browser: 'chrome' | 'safari';
  /** Open a fresh page, install HELPERS, and load the fixture into the player. */
  load(fixture: Fixture): Promise<void>;
  /** Run `body` as an async function in the page, with `G` bound to the helpers. */
  run<T = unknown>(body: string): Promise<T>;
  /** Send one real key press: '.', ',' or ' '. */
  key(k: '.' | ',' | ' '): Promise<void>;
}

/** In-page helpers, installed as `window.__gate` before the fixture loads. */
export const HELPERS = String.raw`
(() => {
  if (window.__gate) return;
  const video = () => document.getElementById('video');
  const ro = () => document.getElementById('readout');
  const G = {
    playT0: null,
    snap: null,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    data: () => ({ ...ro().dataset, text: ro().textContent,
      stepDisabled: document.getElementById('fwd').disabled && document.getElementById('back').disabled,
      currentTime: video().currentTime, paused: video().paused, ended: video().ended,
      duration: video().duration }),
    async waitFor(pred, what, timeout = 15000) {
      const t0 = performance.now();
      while (!pred()) {
        if (performance.now() - t0 > timeout) throw new Error('timeout waiting for ' + what + ': ' + JSON.stringify(G.data()));
        await G.sleep(5);
      }
    },
    // The §2.6 pixel read: draw the <video>, sample each cell's centre, luma > 128 is a 1.
    readFrame() {
      const v = video();
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0, c.width, c.height);
      let n = 0;
      for (let b = 0; b < 9; b++) {
        const [r, g, bl] = ctx.getImageData(40 * b + 20, 20, 1, 1).data;
        if (0.299 * r + 0.587 * g + 0.114 * bl > 128) n |= 1 << b;
      }
      return n;
    },
    // The latest presented frame's mediaTime since the last seek started (null: none yet).
    presented: null,
    // Wait for data-frame to hold k and no seek to be pending. Then wait for a frame callback
    // showing frame k, round(mediaTime·fps) = k, ignoring callbacks for any other frame (a
    // registration from before the seek can fire for the old frame), or up to 1 s if none
    // comes (the clamp case, where the frame on screen does not change). Then read.
    async settleRead(k, fps) {
      await G.waitFor(() => ro().dataset.frame === String(k) && ro().dataset.pending === 'false', 'frame ' + k);
      const t0 = performance.now();
      while (!(G.presented !== null && Math.round(G.presented * fps) === k) && performance.now() - t0 < 1000) {
        await G.sleep(2);
      }
      return G.readFrame();
    },
    // A script seek, as the gate's "Seek to t": set currentTime and wait for seeked.
    async seek(t) {
      const v = video();
      const done = new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      v.currentTime = t;
      await done;
    },
    // Display rate from requestAnimationFrame intervals: median over ~1 s.
    async displayHz() {
      const ts = [];
      await new Promise((resolve) => {
        const tick = (t) => { ts.push(t); if (ts.length < 61) requestAnimationFrame(tick); else resolve(); };
        requestAnimationFrame(tick);
      });
      const gaps = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
      return 1000 / gaps[gaps.length >> 1];
    },
  };
  window.__gate = G;
  const v = video();
  v.addEventListener('seeking', () => { G.presented = null; });
  const onFrame = (_now, meta) => { G.presented = meta.mediaTime; v.requestVideoFrameCallback(onFrame); };
  v.requestVideoFrameCallback(onFrame);
  document.addEventListener('play', () => { if (G.playT0 === null) G.playT0 = performance.now(); }, true);
  new MutationObserver(() => {
    const d = ro().dataset;
    if (G.snap === null && d.dSnapped === 'true') {
      G.snap = { ms: performance.now() - G.playT0, n: +d.n, deltaT: d.deltaT === "" ? null : +d.deltaT, gaps: +d.gaps, runs: +d.runs,
        quantum: +d.quantum, mediaTime: +d.mediaTime, counter: d.counter };
    }
  }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['data-d-snapped'] });
})();
`;

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`[gate] ${msg}`);
}

type Data = Record<string, string | number | boolean> & {
  frame: string;
  dMs: string;
  dSnapped: string;
  pending: string;
  status: string;
  text: string;
  stepDisabled: boolean;
  currentTime: number;
  ended: boolean;
};

const data = (drv: Driver) => drv.run<Data>('return G.data()');
const waitFor = (drv: Driver, cond: string, what: string, timeout = 15000) =>
  drv.run(`await G.waitFor(() => { const d = G.data(); return ${cond}; }, ${JSON.stringify(what)}, ${timeout})`);

/** "d has snapped to exactly 1/fps": the readout's d_ms equals (1/fps)·1000 bit for bit. */
async function assertSnapped(drv: Driver, fps: number, where: string) {
  const d = await data(drv);
  check(d.dSnapped === 'true', `${where}: d not snapped (${JSON.stringify(d)})`);
  check(Number(d.dMs) === (1 / fps) * 1000, `${where}: d_ms ${d.dMs} ≠ exactly 1000/${fps}`);
}

/** Pause with the player's own control (space), and wait for its snap to settle. */
async function pause(drv: Driver) {
  await drv.key(' ');
  await waitFor(drv, `d.paused && d.pending === 'false'`, 'pause and snap');
}

async function seekTo(drv: Driver, frameMid: number, fps: number, expectK: number) {
  await drv.run(`await G.seek(${frameMid}/${fps})`);
  const got = await drv.run<number>(`return G.settleRead(${expectK}, ${fps})`);
  check(got === expectK, `seek to ${frameMid}/${fps}: pixels read ${got}, expected ${expectK}`);
}

/** One key, wait, read; the pixels must show `expect`. Returns the list of reads. */
async function stepAndRead(drv: Driver, key: '.' | ',', expected: number[], fps: number, label: string) {
  const reads: number[] = [];
  for (const k of expected) {
    await drv.key(key);
    const got = await drv.run<number>(`return G.settleRead(${k}, ${fps})`);
    reads.push(got);
    check(got === k, `${label}: after a '${key}' expected frame ${k}, pixels read ${got}`);
  }
  return reads;
}

async function snapRecord(drv: Driver) {
  return drv.run<{ ms: number; n: number; deltaT: number | null; gaps: number; runs: number; quantum: number } | null>(
    'return G.snap',
  );
}

// ---------------------------------------------------------------------------------------

export async function gateA(drv: Driver) {
  await drv.load('frames.mp4');
  // A.1
  let d = await data(drv);
  check(d.stepDisabled && d.status === 'measuring', `A.1: step not disabled on load (${d.status})`);
  // A.2
  await drv.key(' ');
  await waitFor(drv, 'd.currentTime >= 1', 'A.2 1 s of playback');
  await assertSnapped(drv, 30, 'A.2');
  const snap = await snapRecord(drv);
  // A.3
  await pause(drv);
  await seekTo(drv, 10.5, 30, 10);
  // A.4
  await stepAndRead(drv, '.', [11, 12, 13, 14, 15], 30, 'A.4 forward');
  await stepAndRead(drv, ',', [14, 13, 12, 11, 10, 9, 8], 30, 'A.4 back');
  // A.5
  await seekTo(drv, 0.5, 30, 0);
  await stepAndRead(drv, ',', [0], 30, 'A.5 clamp at 0');
  d = await data(drv);
  return { snap };
}

export async function gateB(drv: Driver) {
  await drv.load('frames60ms.mp4');
  // B.1
  await drv.key(' ');
  await waitFor(drv, 'd.currentTime >= 1', 'B.1 1 s of playback');
  let d = await data(drv);
  check(d.stepDisabled, 'B.1: step enabled after 1 s');
  check(d.text.includes('measuring frame rate…'), `B.1: readout lacks "measuring frame rate…": ${d.text}`);
  const at1s = { n: Number(d.n), status: d.status };
  // B.2
  await waitFor(drv, 'd.currentTime >= 3', 'B.2 3 s of playback');
  await assertSnapped(drv, 60, 'B.2');
  const snap = await snapRecord(drv);
  // B.3
  await pause(drv);
  await seekTo(drv, 10.5, 60, 10);
  await stepAndRead(drv, '.', range(11, 51), 60, 'B.3');
  // B.4
  await seekTo(drv, 250.5, 60, 250);
  await stepAndRead(drv, ',', range(210, 250).reverse(), 60, 'B.4');
  // B.5
  await seekTo(drv, 299.5, 60, 299);
  await stepAndRead(drv, '.', [299], 60, 'B.5 clamp at last');
  d = await data(drv);
  return { at1s, snap };
}

export async function gateCb(drv: Driver) {
  await drv.load('frames60ms.mp4');
  await drv.key(' ');
  await waitFor(drv, 'd.currentTime >= 0.5', 'C(b) 0.5 s of playback');
  // Drag the player's own seek bar to 0: set the range input and dispatch `input`.
  const afterDrag = await drv.run<{ pending: string; status: string }>(`
    const s = document.getElementById('seek');
    s.value = '0';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    const d = G.data();
    return { pending: d.pending, status: d.status };
  `);
  check(afterDrag.pending === 'true', `C(b): the seek bar did not set pending (${afterDrag.pending})`);
  check(afterDrag.status === 'measuring', `C(b): d already known before the drag (${afterDrag.status})`);
  await waitFor(drv, `d.pending === 'false'`, 'C(b) pending cleared after the seek bar seek');
  let d = await data(drv);
  check(d.status === 'measuring', `C(b): pending cleared, but d is no longer unknown (${d.status})`);
  // Keep playing until d snaps, which must happen before the clip ends.
  await waitFor(drv, `d.dSnapped === 'true' || d.ended`, 'C(b) snap', 10000);
  await assertSnapped(drv, 60, 'C(b)');
  const snap = await snapRecord(drv);
  d = await data(drv);
  check(!d.ended, 'C(b): clip ended before the snap');
  await pause(drv);
  await seekTo(drv, 100.5, 60, 100);
  await stepAndRead(drv, '.', [101, 102, 103], 60, 'C(b)');
  return { snap };
}

export async function gateCc(drv: Driver) {
  await drv.load('frames120.mp4');
  const hz = await drv.run<number>('return G.displayHz()');
  await drv.key(' ');
  await waitFor(drv, 'd.ended', 'C(c) end of clip', 10000);
  const d = await data(drv);
  const measured = {
    hz,
    counter: String(d.counter),
    status: d.status,
    dMs: d.dMs,
    n: Number(d.n),
    deltaT: d.deltaT === '' ? null : Number(d.deltaT),
    runs: Number(d.runs),
    gaps: Number(d.gaps),
    quantum: Number(d.quantum),
  };
  if (drv.browser === 'chrome') {
    check(d.counter === 'per-frame', `C(c): Chrome's counter is ${d.counter}, expected per-frame`);
  }
  // A batched counter skips the cross-check (OQ-2 limitation): record the outcome only.
  if (d.counter === 'batched') {
    const outcome =
      d.status === 'unsupported' ? 'not-supported' : d.dSnapped === 'true' ? `snapped d_ms=${d.dMs}` : d.status;
    return { outcome, asserted: false, ...measured };
  }
  let outcome: 'not-supported' | 'snapped-1/120';
  if (d.status === 'unsupported') {
    check(d.stepDisabled, 'C(c): unsupported but step is enabled');
    check(
      d.text.includes('frame rate higher than this display can show; stepping not supported yet'),
      `C(c): readout lacks the not-supported message: ${d.text}`,
    );
    outcome = 'not-supported';
  } else {
    check(d.dSnapped === 'true', `C(c): neither outcome: status ${d.status}, d_ms ${d.dMs}`);
    await assertSnapped(drv, 120, 'C(c)');
    outcome = 'snapped-1/120';
    await seekTo(drv, 100.5, 120, 100);
    await stepAndRead(drv, '.', range(101, 111), 120, 'C(c)');
  }
  if (drv.browser === 'chrome' && hz > 55 && hz < 65) {
    check(outcome === 'not-supported', `C(c): Chrome at ${hz.toFixed(1)} Hz must refuse; it ${outcome}`);
  }
  return { outcome, asserted: true, ...measured };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, i) => from + i);
}
