// Gate C(a): the frame-duration estimator (spec vpa-001 §2.3, R7-B2, R7-B1).
import { describe, expect, it } from 'vitest';
import { estimate, Estimator, type EstimateState, type Sample } from '../../src/step';

const usRound = (t: number) => Math.round(t * 1e6) / 1e6;
const msRound = (t: number) => Math.round(t * 1e3) / 1e3;

/**
 * Callbacks for the given frame indices of a `fps` file. totalVideoFrames counts every
 * decoded frame, so it is the frame index itself (plus a constant).
 */
function stream(fps: number, frames: number[], round: (t: number) => number, runId = 0): Sample[] {
  return frames.map((f) => ({ mediaTime: round(f / fps), totalVideoFrames: 100 + f, runId }));
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
/**
 * A run's first callback only starts it, and the second anchors it, so the first counted
 * gap runs from the second callback (frame 1).
 */
/** Frames 0..count-1 with the callback for frame 2 removed: the first counted gap is doubled. */
const firstGapDoubled = (count: number) => range(0, count).filter((f) => f !== 2);
/** Frames 0..count-1 with frames 4–9 removed: counted gap 3 (from frame 3) covers 7 frames. */
const sevenSkipAtGap3 = (count: number) => range(0, count).filter((f) => f < 4 || f > 9);

/** Run a stream, recording every state, and the first sample index at which it snapped. */
function trace(samples: Sample[]) {
  const states: EstimateState[] = [];
  const final = estimate(samples, { onSample: (s) => states.push(s) });
  const firstSnap = states.findIndex((s) => s.status === 'snapped');
  return { states, final, firstSnap };
}

const cases = [
  { name: '30 fps, µs-rounded mediaTime', fps: 30, round: usRound, wrong: [15] },
  { name: '60 fps, whole-ms mediaTime', fps: 60, round: msRound, wrong: [30] },
] as const;

const shapes = [
  { name: 'clean', frames: (n: number) => range(0, n) },
  { name: 'first gap doubled', frames: firstGapDoubled },
  { name: '7-frame skip at gap 3', frames: sevenSkipAtGap3 },
];

describe('C(a) — no wrong snap from an early skipped frame (R7-B2)', () => {
  for (const c of cases) {
    for (const shape of shapes) {
      it(`${c.name}, ${shape.name}: snaps to exactly 1/${c.fps}, never to another rate`, () => {
        // 5 s of frames: enough for the whole-ms snap (N ≥ 134) with margin.
        const { states, final } = trace(stream(c.fps, shape.frames(c.fps * 5), c.round));
        for (const s of states) {
          if (s.status === 'snapped') expect(s.d).toBe(1 / c.fps);
          expect(s.status).not.toBe('unsupported');
          for (const w of c.wrong) expect(s.d).not.toBe(1 / w);
        }
        expect(final.status).toBe('snapped');
        expect(final.d).toBe(1 / c.fps);
      });
    }
  }

  it('snaps at no fewer than 10 counted gaps', () => {
    // 30 fps µs: ε is tiny from the start, so only the 10-gap minimum holds the snap back.
    const samples = stream(30, range(0, 40), usRound);
    const { states, firstSnap } = trace(samples);
    expect(states[firstSnap].gaps).toBe(10);
    for (const s of states.slice(0, firstSnap)) expect(s.status).toBe('measuring');
    // The R7-B2 case: first gap doubled. Without the minimum it would snap to 15 at N = 1.
    const doubled = trace(stream(30, firstGapDoubled(40), usRound));
    expect(doubled.states[doubled.firstSnap].gaps).toBe(10);
    expect(doubled.final.d).toBe(1 / 30);
  });

  it('recounts n_g for every stored gap when d_min drops', () => {
    // Gaps: 2d, then d. After the first, d_min = 2d, so n = 1 and N = 1. After the second,
    // d_min drops to d and the first gap is recounted as 2: N = 2 + 1 = 3, not 1 + 1 = 2.
    const est = new Estimator(true);
    const d = 1 / 30;
    const s = (f: number): Sample => ({ mediaTime: usRound(f * d), totalVideoFrames: f, runId: 0 });
    est.push(s(0)); // the run's first callback only starts the run
    est.push(s(0)); // anchors
    est.push(s(2));
    expect(est.state().N).toBe(1);
    expect(est.state().dMin).toBeCloseTo(2 * d, 5);
    est.push(s(3));
    expect(est.state().N).toBe(3);
    expect(est.state().dMin).toBeCloseTo(d, 5);
    // A 6-frame gap afterwards adds 6.
    est.push(s(9));
    expect(est.state().N).toBe(9);
  });
});

describe('the snap bound and the quantum E', () => {
  it('detects E: 1 µs for µs-rounded 30 fps, 1 ms for whole-ms 60 fps, 10 ms for 25 fps', () => {
    expect(estimate(stream(30, range(0, 20), usRound)).E).toBe(1e-6);
    expect(estimate(stream(60, range(0, 20), msRound)).E).toBe(0.001);
    expect(estimate(stream(25, range(0, 20), usRound)).E).toBe(0.01);
  });

  it('whole-ms 60 fps snaps at N = 134 (2.23 s), not before (R7-N1 margin)', () => {
    const { states, firstSnap } = trace(stream(60, range(0, 300), msRound));
    expect(states[firstSnap].N).toBe(134);
    expect(states[firstSnap - 1].N).toBe(133);
    expect(states[firstSnap - 1].status).toBe('measuring');
  });

  it('a second run doubles ε: whole-ms 60 fps with R = 2 needs N ≥ 267', () => {
    const samples = [
      ...stream(60, range(0, 30), msRound, 0),
      ...stream(60, range(0, 300), msRound, 1),
    ];
    const { states, firstSnap } = trace(samples);
    expect(states[firstSnap].R).toBe(2);
    expect(states[firstSnap].N).toBeGreaterThanOrEqual(267);
    expect(states[firstSnap].d).toBe(1 / 60);
  });
});

describe('frame-count cross-check (R7-B1)', () => {
  it('120 fps presented at 60: ΔT = 2N, so it refuses instead of snapping to 60', () => {
    const everyOther = range(0, 240).filter((f) => f % 2 === 0);
    const { states, final } = trace(stream(120, everyOther, usRound));
    expect(states.every((s) => s.status !== 'snapped')).toBe(true);
    expect(final.status).toBe('unsupported');
    expect(final.d).toBeNull();
    expect(final.gaps).toBe(10); // estimation stopped at the first decision point
  });

  it('whole-ms 300 fps presented at 60 does not snap to 100', () => {
    const everyFifth = range(0, 1500).filter((f) => f % 5 === 0);
    const final = estimate(stream(300, everyFifth, msRound));
    expect(final.status).toBe('unsupported');
  });

  it('the cap does not re-enable an unsupported file', () => {
    const everyOther = range(0, 240).filter((f) => f % 2 === 0);
    expect(estimate(stream(120, everyOther, usRound), { ended: true }).status).toBe('unsupported');
  });
});

describe('the cap', () => {
  it('12.5 fps (not a candidate) is enabled uncertain after 30 s of counted playback', () => {
    const { states, final } = trace(stream(12.5, range(0, 400), usRound));
    expect(states.every((s) => s.status !== 'snapped')).toBe(true);
    expect(final.status).toBe('uncertain');
    expect(final.E).toBe(0.01);
    expect(final.d).toBeCloseTo(0.08, 9);
    const firstUncertain = states.findIndex((s) => s.status === 'uncertain');
    expect(states[firstUncertain].S).toBeGreaterThanOrEqual(30);
    expect(states[firstUncertain - 1].S).toBeLessThan(30);
  });

  it('`ended` applies the cap early, but not with fewer than 10 counted gaps', () => {
    expect(estimate(stream(12.5, range(0, 20), usRound), { ended: true }).status).toBe(
      'uncertain',
    );
    expect(estimate(stream(12.5, range(0, 10), usRound), { ended: true }).status).toBe(
      'measuring',
    );
  });

  it('without getVideoPlaybackQuality nothing snaps; only the cap enables step', () => {
    const samples = stream(30, range(0, 60), usRound).map((s) => ({ ...s, totalVideoFrames: null }));
    const running = estimate(samples);
    expect(running.status).toBe('measuring');
    const ended = estimate(samples, { ended: true });
    expect(ended.status).toBe('uncertain');
    expect(ended.d).toBeCloseTo(1 / 30, 6);
  });
});

describe('long gaps (amended at the build): a gap over 7 × d_min is not counted', () => {
  /**
   * The stalled-Safari pattern (build soak): whole-ms 60 fps where the callbacks fall
   * behind, about 3 frames per callback on average, with some stalls of 12+ frames.
   * Before the rule, round(g / 16 ms) overcounted those, nothing snapped, and the cap
   * enabled step with d = 16.199 ms.
   */
  const stalled = (): Sample[] => {
    // Averages 2.75 frames per callback, with a 12- and a 13-frame stall every 20 callbacks.
    const skips = [1, 2, 1, 3, 2, 1, 12, 1, 2, 1, 3, 2, 1, 1, 13, 2, 1, 2, 1, 3];
    const frames = [0];
    for (let i = 0; frames[frames.length - 1] + skips[i % skips.length] < 300; i++) {
      frames.push(frames[frames.length - 1] + skips[i % skips.length]);
    }
    return frames.map((f) => ({ mediaTime: msRound(f / 60), totalVideoFrames: 0, runId: 0 }));
  };

  it('the stalled pattern: at `ended`, uncertain with d within ε of 1/60 (was 16.199 ms)', () => {
    const { states } = trace(stalled());
    expect(states.every((s) => s.d === null)).toBe(true); // nothing enabled while playing
    const final = estimate(stalled(), { ended: true });
    expect(final.status).toBe('uncertain');
    expect(Math.abs(final.d! - 1 / 60)).toBeLessThanOrEqual(final.epsilon!);
    expect(final.R).toBeGreaterThan(1); // each uncounted stall split the run
  });

  it('a gap too long now is re-checked when d_min drops: counted at 7 × 33 ms, not at 7 × 16 ms', () => {
    const est = new Estimator(false);
    const t = (ms: number): Sample => ({ mediaTime: ms / 1000, totalVideoFrames: null, runId: 0 });
    est.push(t(0));
    est.push(t(0)); // first callback only starts the run; this anchors
    est.push(t(33)); // d_min = 33 ms
    est.push(t(183)); // 150 ms: within 7 × 33 = 231 ms, counted
    expect(est.state().gaps).toBe(2);
    est.push(t(199)); // 16 ms: d_min drops; 150 ms > 7 × 16 = 112 ms, no longer counted
    expect(est.state().gaps).toBe(2);
    expect(est.state().S).toBeCloseTo(0.049, 9);
    expect(est.state().R).toBe(2); // the uncounted gap splits the run
  });
});

describe('runs', () => {
  it('a gap across runs never counts, nor does the gap from a run\'s first callback', () => {
    // 5 callbacks per run: the first starts it, the second anchors, 3 gaps count.
    const a = stream(30, range(0, 5), usRound, 0);
    const b = stream(30, range(50, 55), usRound, 1);
    const s = estimate([...a, ...b]);
    expect(s.gaps).toBe(6);
    expect(s.N).toBe(6);
    expect(s.R).toBe(2);
    expect(s.deltaT).toBe(6);
  });

  it('gaps shorter than 1/240 s − 1 ms are ignored; a whole-ms 240 fps gap (4 ms) is not', () => {
    const a = stream(30, range(0, 5), usRound, 0);
    const short = { ...a[4], mediaTime: a[4].mediaTime + 0.00208 }; // the Safari 2.08 ms
    expect(estimate([...a, short]).gaps).toBe(3);
    expect(estimate([...a, short]).dMin).toBeCloseTo(1 / 30, 5);
    const four = { ...a[4], mediaTime: a[4].mediaTime + 0.004 };
    expect(estimate([...a, four]).dMin).toBeCloseTo(0.004, 9); // counted: d_min drops to it
    // Whole-ms 240 fps (gaps of 4 and 5 ms) snaps to exactly 1/240.
    expect(estimate(stream(240, range(0, 2000), msRound)).d).toBe(1 / 240);
  });
});

describe('amended R7-B1 — a batched totalVideoFrames counter (Safari 26.6.2)', () => {
  /**
   * The counter as Safari reported it on frames60ms.mp4 (build log): 1 at the first callback
   * (0.017 s), 19 from the second (decode-ahead), 135 from 1.983 s, 251 from 3.983 s.
   */
  const safariCounter60 = (f: number) => (f < 2 ? 1 : f < 119 ? 19 : f < 239 ? 135 : 251);
  const safari60 = (): Sample[] =>
    range(1, 300).map((f) => ({ mediaTime: msRound(f / 60), totalVideoFrames: safariCounter60(f), runId: 0 }));

  it('the build failure: at 10 gaps ΔT is far from N, so a per-frame check would refuse', () => {
    // Under the first-callback rule the 1 → 19 jump falls before the anchor, and the
    // counter then holds: ΔT = 0 against N = 10.
    const { states } = trace(safari60());
    const at10 = states.find((s) => s.gaps === 10)!;
    expect(at10.deltaT).toBe(0);
    expect(at10.N).toBe(10);
    // Outside the band 0.1·N + 3·R = 4 — the per-frame check would refuse here.
    expect(Math.abs(at10.deltaT! - at10.N)).toBeGreaterThan(0.1 * at10.N + 3 * at10.R);
  });

  it('whole-ms 60 fps with the Safari counter: batched, never refused, snaps to exactly 1/60 at N = 134', () => {
    const { states, final, firstSnap } = trace(safari60());
    const decided = states.findIndex((s) => s.counter !== 'unknown');
    expect(states[decided].counter).toBe('batched');
    expect(states[decided].gaps).toBe(8); // counted gaps 1–8 all held at 19
    expect(states.every((s) => s.status !== 'unsupported')).toBe(true);
    expect(states[firstSnap].N).toBe(134);
    expect(final.d).toBe(1 / 60);
  });

  it('30 fps µs with the Safari counter (1 → 12, then held): snaps to exactly 1/30', () => {
    const samples = range(1, 90).map((f) => ({
      mediaTime: usRound(f / 30),
      totalVideoFrames: f < 2 ? 1 : f < 60 ? 12 : 65,
      runId: 0,
    }));
    const final = estimate(samples);
    expect(final.counter).toBe('batched');
    expect(final.status).toBe('snapped');
    expect(final.d).toBe(1 / 30);
  });

  it('known limitation (OQ-2): with a batched counter, 120 fps presented at 60 snaps to 60', () => {
    const everyOther = range(0, 240).filter((f) => f % 2 === 0);
    const samples = everyOther.map((f) => ({
      mediaTime: usRound(f / 120),
      totalVideoFrames: f === 0 ? 1 : 30,
      runId: 0,
    }));
    const final = estimate(samples);
    expect(final.counter).toBe('batched');
    expect(final.d).toBe(1 / 60);
  });

  it('a per-frame counter is decided at 8 advancing gaps, and then the check applies', () => {
    const { states } = trace(stream(30, range(0, 20), usRound));
    const decided = states.findIndex((s) => s.counter !== 'unknown');
    expect(states[decided].counter).toBe('per-frame');
    expect(states[decided].gaps).toBe(8);
  });

  it('until the mode is known, nothing snaps, nothing is refused, and the cap does not enable', () => {
    // Runs of 4 counted gaps: neither 8 advancing nor 8 flat gaps ever fall in one run.
    const samples = range(0, 6).flatMap((r) => stream(30, range(r * 10, r * 10 + 6), usRound, r));
    const final = estimate(samples, { ended: true });
    expect(final.gaps).toBe(24);
    expect(final.counter).toBe('unknown');
    expect(final.status).toBe('measuring');
    expect(final.d).toBeNull();
  });
});
