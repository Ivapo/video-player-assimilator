// Frame-by-frame step (spec vpa-001 §2.3).
//
// Two parts. The Estimator turns the presented-frame callbacks into a frame duration `d`,
// snapped to a standard rate when that is provably the file's own. The StepController owns
// the frame index `k` and the seeks that move it.

// ---------------------------------------------------------------------------------------
// Frame-duration estimate
// ---------------------------------------------------------------------------------------

/** One `requestVideoFrameCallback` call, as the estimator sees it. */
export interface Sample {
  mediaTime: number;
  /** `getVideoPlaybackQuality().totalVideoFrames`, or null where the browser lacks it. */
  totalVideoFrames: number | null;
  /** A pause, seek or `ended` starts a new run; gaps across runs never count. */
  runId: number;
}

export type EstimateStatus =
  | 'measuring' // step disabled, "measuring frame rate…"
  | 'snapped' // d is a standard rate exactly; estimation has stopped
  | 'uncertain' // enabled at the cap with d = d_est; "frame rate uncertain"
  | 'unsupported'; // cross-check disagreed; estimation has stopped

/**
 * How `totalVideoFrames` moves: per decoded frame (Chrome), or in batches (Safari 26.6.2).
 * Until one is seen, the cross-check neither agrees nor disagrees.
 */
export type CounterMode = 'unknown' | 'per-frame' | 'batched';

export interface EstimateState {
  status: EstimateStatus;
  /** The frame duration in seconds, or null while step is disabled. */
  d: number | null;
  dEst: number | null;
  dMin: number | null;
  /** Number of counted gaps. */
  gaps: number;
  /** Sum of the counted gaps, s. */
  S: number;
  /** Sum of n_g over the counted gaps. */
  N: number;
  /** Runs that contain at least one counted gap. */
  R: number;
  /** Timestamp quantum, s. */
  E: number;
  epsilon: number | null;
  /** Sum over runs of the change in totalVideoFrames; null without the API. */
  deltaT: number | null;
  counter: CounterMode;
  capReached: boolean;
}

/**
 * Gaps shorter than this are ignored: 1/240 s, the shortest frame of any candidate rate,
 * less 1 ms for whole-ms timestamps (a 240 fps whole-ms file has 4 ms gaps). Phase 1
 * supports rates up to the display's, and no candidate is faster than 240 fps, so a
 * shorter gap is not a frame (amended at the build, from 1 ms).
 */
export const MIN_GAP = 1 / 240 - 0.001;
/** No snap, and no enable at the cap, before this many counted gaps (R7-B2). */
const MIN_GAPS = 10;
/** The cap: this much counted playback, s. */
const CAP_SECONDS = 30;
/** The snap margin: ε ≤ 0.9 · gap(c) / 2 (R7-N1). */
const SNAP_MARGIN = 0.9;
/** A mediaTime is on the q-grid when it is within this of a multiple of q. */
const GRID_TOLERANCE = 1e-6;
const QUANTA = [0.1, 0.01, 0.001] as const;
const FINEST_QUANTUM = 1e-6;
/** Consecutive counted gaps of one run that decide the counter mode (amended R7-B1). */
const COUNTER_RUN = 8;
/**
 * A gap longer than this many d_min is not counted (amended at the build): beyond it,
 * round(g / d_min) is no longer exact for whole-ms timestamps at 60 fps.
 */
const MAX_FRAMES_PER_GAP = 7;

interface Candidate {
  d: number;
  /** Distance to the nearest other candidate. */
  gap: number;
}

/** Every whole rate n fps and every n × 1000/1001 fps, n = 1…240, sorted by duration. */
export const CANDIDATES: readonly Candidate[] = (() => {
  const ds: number[] = [];
  for (let n = 1; n <= 240; n++) {
    ds.push(1 / n, 1001 / (1000 * n));
  }
  ds.sort((a, b) => a - b);
  return ds.map((d, i) => ({
    d,
    gap: Math.min(i > 0 ? d - ds[i - 1] : Infinity, i < ds.length - 1 ? ds[i + 1] - d : Infinity),
  }));
})();

function nearestCandidate(d: number): Candidate {
  let best = CANDIDATES[0];
  for (const c of CANDIDATES) {
    if (Math.abs(c.d - d) < Math.abs(best.d - d)) best = c;
  }
  return best;
}

function onGrid(t: number, q: number): boolean {
  return Math.abs(t - Math.round(t / q) * q) <= GRID_TOLERANCE;
}

interface Run {
  id: number;
  /** False until the run's second callback: the first only starts the run. */
  primed: boolean;
  /** The anchor: the last callback that was not ignored. */
  lastTime: number;
  lastFrames: number | null;
  /** Consecutive gaps on which the counter moved, and on which it did not. */
  advancing: number;
  flat: number;
}

/** One gap between consecutive callbacks of a run, as stored for every recount. */
interface Gap {
  t0: number;
  t1: number;
  g: number;
  runId: number;
  /** The counter's change across the gap; null without the API. */
  dT: number | null;
}

export class Estimator {
  private readonly hasQuality: boolean;
  private status: EstimateStatus = 'measuring';
  private d: number | null = null;
  /** Every gap at or above the floor, counted or not. */
  private gapList: Gap[] = [];
  private dMin = Infinity;
  private run: Run | null = null;
  private capReached = false;
  private counter: CounterMode = 'unknown';

  // Derived from the counted gaps: rebuilt in full whenever d_min drops.
  private counted = 0;
  private S = 0;
  private N = 0;
  /** Segments with a counted gap: a run, split again at every gap not counted. */
  private R = 0;
  private dTSum = 0;
  /** Which quanta every counted mediaTime still sits on. */
  private onQuantum = QUANTA.map(() => true);
  private segRun: number | null = null;
  private segOpen = false;

  constructor(hasQuality: boolean) {
    this.hasQuality = hasQuality;
  }

  /** Feed one callback. Returns true when `d` changed. */
  push(s: Sample): boolean {
    if (this.status === 'snapped' || this.status === 'unsupported') return false;
    const run = this.run;
    if (!run || run.id !== s.runId || s.mediaTime < run.lastTime) {
      this.run = {
        id: s.runId,
        primed: false,
        lastTime: s.mediaTime,
        lastFrames: s.totalVideoFrames,
        advancing: 0,
        flat: 0,
      };
      return false;
    }
    if (!run.primed) {
      // The gap from a run's first callback is never counted: after a seek, that callback
      // can report a position that is not a presented frame. The second callback anchors.
      run.primed = true;
      run.lastTime = s.mediaTime;
      run.lastFrames = s.totalVideoFrames;
      return false;
    }
    const g = s.mediaTime - run.lastTime;
    if (g < MIN_GAP) return false; // ignored; the anchor stays

    const gap: Gap = {
      t0: run.lastTime,
      t1: s.mediaTime,
      g,
      runId: run.id,
      dT: s.totalVideoFrames !== null && run.lastFrames !== null ? s.totalVideoFrames - run.lastFrames : null,
    };
    this.noteCounter(run, s.totalVideoFrames);
    run.lastTime = s.mediaTime;
    run.lastFrames = s.totalVideoFrames;

    this.gapList.push(gap);
    if (g < this.dMin) {
      // d_min dropped: recount every stored gap against it (R7-B2), including which gaps
      // are too long to count.
      this.dMin = g;
      this.recount();
    } else {
      this.admit(gap);
    }
    if (this.S >= CAP_SECONDS) this.capReached = true;
    return this.decide();
  }

  /** `ended` arrived: the cap applies from now on. Returns true when `d` changed. */
  atEnd(): boolean {
    if (this.status !== 'measuring') return false;
    this.capReached = true;
    return this.decide();
  }

  state(): EstimateState {
    const dEst = this.N > 0 ? this.S / this.N : null;
    return {
      status: this.status,
      d: this.d,
      dEst,
      dMin: Number.isFinite(this.dMin) ? this.dMin : null,
      gaps: this.counted,
      S: this.S,
      N: this.N,
      R: this.R,
      E: this.quantum(),
      epsilon: this.N > 0 ? (this.R * this.quantum()) / this.N : null,
      deltaT: this.hasQuality ? this.dTSum : null,
      counter: this.counter,
      capReached: this.capReached,
    };
  }

  private recount(): void {
    this.counted = this.S = this.N = this.R = this.dTSum = 0;
    this.onQuantum = QUANTA.map(() => true);
    this.segRun = null;
    this.segOpen = false;
    for (const gap of this.gapList) this.admit(gap);
  }

  /**
   * Count one gap against the current d_min, in stream order. A gap longer than
   * MAX_FRAMES_PER_GAP × d_min is not counted: its frame count is no longer exact. It
   * ends a segment, because S no longer telescopes across it.
   */
  private admit(gap: Gap): void {
    if (gap.runId !== this.segRun) {
      this.segRun = gap.runId;
      this.segOpen = false;
    }
    if (gap.g > MAX_FRAMES_PER_GAP * this.dMin) {
      this.segOpen = false;
      return;
    }
    if (!this.segOpen) {
      this.segOpen = true;
      this.R++;
    }
    this.counted++;
    this.S += gap.g;
    this.N += Math.round(gap.g / this.dMin);
    this.dTSum += gap.dT ?? 0;
    this.noteTime(gap.t0);
    this.noteTime(gap.t1);
  }

  private noteTime(t: number): void {
    QUANTA.forEach((q, i) => {
      if (this.onQuantum[i] && !onGrid(t, q)) this.onQuantum[i] = false;
    });
  }

  /** Per-frame once it moves on 8 gaps in a row of one run; batched once it holds on 8. */
  private noteCounter(run: Run, frames: number | null): void {
    if (this.counter !== 'unknown' || frames === null || run.lastFrames === null) return;
    if (frames > run.lastFrames) {
      run.advancing++;
      run.flat = 0;
    } else {
      run.flat++;
      run.advancing = 0;
    }
    if (run.advancing >= COUNTER_RUN) this.counter = 'per-frame';
    else if (run.flat >= COUNTER_RUN) this.counter = 'batched';
  }

  private quantum(): number {
    const i = this.onQuantum.indexOf(true);
    return i >= 0 ? QUANTA[i] : FINEST_QUANTUM;
  }

  /** Apply the snap, cross-check and cap rules. Returns true when `d` changed. */
  private decide(): boolean {
    if (this.counted < MIN_GAPS) return false;
    const before = this.d;
    const dEst = this.S / this.N;

    if (this.hasQuality) {
      // Until the counter's mode is known, the check neither agrees nor disagrees: hold.
      if (this.counter === 'unknown') return false;
      const dT = this.dTSum;
      // A batched counter cannot count frames per run: skip the check (OQ-2 limitation).
      if (this.counter === 'per-frame' && Math.abs(dT - this.N) > 0.1 * this.N + 3 * this.R) {
        // N does not count the file's frames: the file is faster than the display presents.
        this.status = 'unsupported';
        this.d = null;
        return before !== null;
      }
      const eps = (this.R * this.quantum()) / this.N;
      const c = nearestCandidate(dEst);
      if (eps <= (SNAP_MARGIN * c.gap) / 2 && Math.abs(dEst - c.d) <= eps) {
        this.status = 'snapped';
        this.d = c.d;
        return this.d !== before;
      }
    }

    if (this.capReached) {
      this.status = 'uncertain';
      this.d = dEst;
    }
    return this.d !== before;
  }
}

/**
 * The estimator as a pure function over a stream of samples. `ended` applies the cap at
 * the end of the stream. The optional `onSample` sees the state after every sample.
 */
export function estimate(
  samples: readonly Sample[],
  opts: { ended?: boolean; onSample?: (state: EstimateState, i: number) => void } = {},
): EstimateState {
  const est = new Estimator(samples.every((s) => s.totalVideoFrames !== null));
  samples.forEach((s, i) => {
    est.push(s);
    opts.onSample?.(est.state(), i);
  });
  if (opts.ended) est.atEnd();
  return est.state();
}

// ---------------------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------------------

export type Dir = 1 | -1;

/** What the readout shows. */
export interface StepView {
  k: number;
  kValid: boolean;
  pending: boolean;
  lastMediaTime: number;
  /** Step is available: d is known and the browser has the callback. */
  enabled: boolean;
  noCallback: boolean;
  /** After a paused seek, no frame callback showed the target within STALE_MS. */
  stale: boolean;
  estimate: EstimateState;
}

/**
 * After a paused seek, the time a frame callback has to show the target frame before the
 * picture is flagged stale (amended at the build: Safari sometimes keeps the old picture).
 */
export const STALE_MS = 250;

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    cb: (now: number, meta: { mediaTime: number }) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export class StepController {
  private readonly video: FrameCallbackVideo;
  private readonly onChange: () => void;
  readonly noCallback: boolean;
  private readonly hasQuality: boolean;

  // Player state (§2.3).
  private k = 0;
  private kTime = NaN;
  private kValid = false;
  private pending = false;
  private ownPaused = true;
  private queue: Dir[] = [];

  // Estimate inputs.
  private est: Estimator;
  private runId = 0;
  private lastMediaTime = NaN;
  /** Set between the player's own pause() and its `pause` event. */
  private ownPauseEvent = false;
  /**
   * The frame-callback registration. `seeked` and a new file replace it with a fresh one;
   * a callback whose generation is not current (one that fires, although replaced, for a
   * pre-seek frame) is ignored.
   */
  private frameGen = 0;
  private frameHandle: number | null = null;

  // Stale-picture detection (Safari). Every callback counts here, whatever its generation.
  private stale = false;
  /** The frame a paused seek landed on, until a callback shows it. */
  private staleTarget: number | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  /** mediaTimes of callbacks since the current seek started. */
  private sinceSeek: number[] = [];

  constructor(video: HTMLVideoElement, onChange: () => void) {
    this.video = video as FrameCallbackVideo;
    this.onChange = onChange;
    this.noCallback = typeof this.video.requestVideoFrameCallback !== 'function';
    this.hasQuality = typeof video.getVideoPlaybackQuality === 'function';
    this.est = new Estimator(this.hasQuality);

    video.addEventListener('seeked', () => this.onSeeked());
    video.addEventListener('seeking', () => {
      this.endRun();
      this.sinceSeek = [];
      this.staleTarget = null;
      this.clearStaleTimer();
    });
    video.addEventListener('pause', () => this.onPause());
    video.addEventListener('ended', () => this.onEnded());
    video.addEventListener('play', () => {
      this.kValid = false;
      this.ownPaused = false;
      // Playback replaces the picture: a stale warning no longer applies.
      this.stale = false;
      this.staleTarget = null;
      this.clearStaleTimer();
      this.onChange();
    });
    video.addEventListener('loadedmetadata', () => this.onChange());
    this.watchFrames();
  }

  /** Reset on a new file: call in the same task, before the new `src` is set. */
  reset(): void {
    this.queue = [];
    this.pending = false;
    this.kValid = false;
    this.k = 0;
    this.kTime = NaN;
    this.ownPaused = true;
    this.ownPauseEvent = false;
    this.est = new Estimator(this.hasQuality);
    this.runId++;
    this.lastMediaTime = NaN;
    this.stale = false;
    this.staleTarget = null;
    this.sinceSeek = [];
    this.clearStaleTimer();
    // A file arriving mid-seek never fires that seek's `seeked`: register afresh.
    this.watchFrames();
    this.onChange();
  }

  view(): StepView {
    return {
      k: this.k,
      kValid: this.kValid,
      pending: this.pending,
      lastMediaTime: this.lastMediaTime,
      enabled: this.enabled(),
      noCallback: this.noCallback,
      stale: this.stale,
      estimate: this.est.state(),
    };
  }

  enabled(): boolean {
    return !this.noCallback && this.d() !== null && Number.isFinite(this.video.duration);
  }

  /** The player's own play(). */
  play(): void {
    this.kValid = false;
    this.ownPaused = false;
    void this.video.play().catch(() => {
      // Refused (for example by an autoplay policy): the video stays paused.
      this.ownPaused = this.video.paused;
      this.onChange();
    });
    this.onChange();
  }

  /** The player's own pause(): it snaps in the same task. */
  pause(): void {
    if (!this.video.paused) this.ownPauseEvent = true;
    this.video.pause();
    this.ownPaused = true;
    this.snap();
    this.onChange();
  }

  togglePlay(): void {
    if (this.video.paused) this.play();
    else this.pause();
  }

  /** The player's own seek bar. */
  seekTo(t: number): void {
    this.ownSeek(t);
    this.onChange();
  }

  /** A `.`/`,` press, a button, or the head of the queue. */
  step(dir: Dir): void {
    if (!this.enabled()) return;
    // 1. A seek is pending: queue the press.
    if (this.pending) {
      this.queue.push(dir);
      this.onChange();
      return;
    }
    // 2. Moved without the player knowing.
    if (this.video.paused !== this.ownPaused || this.video.currentTime !== this.kTime) {
      this.kValid = false;
      this.ownPaused = this.video.paused;
    }
    // 3. k is not valid: snap first, and put this press at the head of the queue.
    if (!this.kValid) {
      if (!this.video.paused) this.pause();
      else this.snap();
      this.queue.unshift(dir);
      this.onChange();
      return;
    }
    // 4. Step.
    const d = this.d()!;
    this.k = clamp(this.k + dir, 0, this.last());
    this.kValid = false;
    this.pending = true;
    this.video.currentTime = (this.k + 0.5) * d;
    this.onChange();
  }

  private d(): number | null {
    return this.est.state().d;
  }

  private last(): number {
    return Math.round(this.video.duration / this.d()!) - 1;
  }

  /** Put the picture on the middle of the frame the video stopped on. */
  private snap(): void {
    const d = this.d();
    if (d === null || !Number.isFinite(this.video.duration)) return;
    const t = this.video.currentTime;
    this.ownSeek((clamp(Math.floor(t / d + 0.001), 0, this.last()) + 0.5) * d);
  }

  private ownSeek(t: number): void {
    this.kValid = false;
    this.pending = true;
    this.video.currentTime = t;
  }

  private endRun(): void {
    this.runId++;
  }

  private watchFrames(): void {
    if (this.noCallback) return;
    this.unwatchFrames();
    const gen = this.frameGen;
    this.frameHandle = this.video.requestVideoFrameCallback!((_now, meta) => this.onFrame(gen, meta));
  }

  private unwatchFrames(): void {
    if (this.frameHandle !== null) this.video.cancelVideoFrameCallback?.(this.frameHandle);
    this.frameHandle = null;
    this.frameGen++;
  }

  private onSeeked(): void {
    // A newer seek is in flight; wait for its `seeked`.
    if (this.video.seeking) return;
    this.watchFrames();
    this.pending = false;
    const d = this.d();
    if (d !== null && Number.isFinite(this.video.duration)) {
      const t = this.video.currentTime;
      this.k = clamp(Math.floor(t / d + 0.001), 0, this.last());
      this.kTime = t;
      this.kValid = true;
      if (this.video.paused) this.watchForTarget(this.k, d);
    }
    const next = this.queue.shift();
    if (next !== undefined) this.step(next);
    this.onChange();
  }

  private onPause(): void {
    this.endRun();
    if (this.ownPauseEvent) {
      this.ownPauseEvent = false;
    } else {
      // A pause the player did not cause: no snap; the next step snaps.
      this.ownPaused = true;
      this.kValid = false;
    }
    this.onChange();
  }

  private onEnded(): void {
    this.endRun();
    this.ownPaused = true;
    this.kValid = false;
    this.est.atEnd(); // the cap applies from `ended`
    this.onChange();
  }

  /**
   * A paused seek landed on frame `target`: a frame callback must show it, round(mediaTime
   * / d) = target, within STALE_MS, or the picture is flagged stale. A callback that came
   * before `seeked` counts.
   */
  private watchForTarget(target: number, d: number): void {
    this.clearStaleTimer();
    if (this.sinceSeek.some((t) => Math.round(t / d) === target)) {
      this.stale = false;
      this.staleTarget = null;
      return;
    }
    this.staleTarget = target;
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null;
      if (this.staleTarget !== null) {
        this.stale = true;
        this.onChange();
      }
    }, STALE_MS);
  }

  private clearStaleTimer(): void {
    if (this.staleTimer !== null) clearTimeout(this.staleTimer);
    this.staleTimer = null;
  }

  private onFrame(gen: number, meta: { mediaTime: number }): void {
    // Stale-picture detection sees every callback, whatever its generation.
    this.sinceSeek.push(meta.mediaTime);
    if (this.sinceSeek.length > 8) this.sinceSeek.shift();
    const d = this.d();
    if (this.staleTarget !== null && d !== null && Math.round(meta.mediaTime / d) === this.staleTarget) {
      this.staleTarget = null;
      this.clearStaleTimer();
      if (this.stale) {
        this.stale = false;
        this.onChange();
      }
    }
    // A cancelled registration that still fires: its frame is from before the seek.
    if (gen !== this.frameGen) return;
    this.watchFrames();
    this.lastMediaTime = meta.mediaTime;
    // A run is a stretch of playback: frames presented while paused (after a seek) are not
    // part of one.
    if (!this.video.paused) {
      const changed = this.est.push({
        mediaTime: meta.mediaTime,
        totalVideoFrames: this.hasQuality
          ? this.video.getVideoPlaybackQuality().totalVideoFrames
          : null,
        runId: this.runId,
      });
      if (changed) this.kValid = false;
    }
    this.onChange();
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}
