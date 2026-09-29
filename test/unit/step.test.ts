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
/** Frames 0..count-1 with the callback for frame 1 removed: the first gap is doubled. */
const firstGapDoubled = (count: number) => range(0, count).filter((f) => f !== 1);
/** Frames 0..count-1 with frames 4–9 removed: gap 3 (from frame 3) covers 7 frames. */
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
    est.push(s(0));
    est.push(s(2));
    expect(est.state().N).toBe(1);
    expect(est.state().dMin).toBeCloseTo(2 * d, 5);
    est.push(s(3));
    expect(est.state().N).toBe(3);
    expect(est.state().dMin).toBeCloseTo(d, 5);
    // A 7-frame gap afterwards adds 7.
    est.push(s(10));
    expect(est.state().N).toBe(10);
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

describe('runs', () => {
  it('a gap across runs never counts, and gaps of 1 ms or less are ignored', () => {
    const a = stream(30, range(0, 5), usRound, 0);
    const b = stream(30, range(50, 55), usRound, 1);
    const dup = { ...a[4], mediaTime: a[4].mediaTime + 0.0005 };
    const s = estimate([...a, dup, ...b]);
    expect(s.gaps).toBe(8);
    expect(s.N).toBe(8);
    expect(s.R).toBe(2);
    expect(s.deltaT).toBe(8);
  });
});
