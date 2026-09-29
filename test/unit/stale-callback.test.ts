// Gate C(a), build amendment: a stale frame callback after a seek must not seed a bogus gap
// (Safari, d = 2.08 ms). Drives the real StepController with a scripted <video>.
import { describe, expect, it } from 'vitest';
import { StepController } from '../../src/step';

type FrameCb = (now: number, meta: { mediaTime: number }) => void;

/** A scripted <video>: frames, seeks and callbacks happen only when the test says so. */
class FakeVideo extends EventTarget {
  paused = true;
  seeking = false;
  duration = 4.999; // frames60ms.mp4
  private t = 0;
  private frames = 0;
  private cbs = new Map<number, FrameCb>();
  /** Registrations the browser holds back, to fire late: only `fire(t, ids)` fires them. */
  private held = new Map<number, FrameCb>();
  private nextId = 0;

  get currentTime() {
    return this.t;
  }
  set currentTime(v: number) {
    this.t = v;
    this.seeking = true;
    this.dispatchEvent(new Event('seeking'));
  }
  requestVideoFrameCallback(cb: FrameCb) {
    this.cbs.set(++this.nextId, cb);
    return this.nextId;
  }
  /** Models a cancelled registration that still fires: cancel does nothing here. */
  cancelVideoFrameCallback(_id: number) {}
  getVideoPlaybackQuality() {
    return { totalVideoFrames: this.frames } as VideoPlaybackQuality;
  }
  play() {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  /** Hold back the registrations waiting now; they fire late, as stale ones. */
  holdPending(): number[] {
    const ids = [...this.cbs.keys()];
    ids.forEach((id) => this.held.set(id, this.cbs.get(id)!));
    this.cbs.clear();
    return ids;
  }
  /** Fire the given registrations (default: all current ones) with this mediaTime. */
  fire(mediaTime: number, ids = [...this.cbs.keys()]) {
    const cbs = ids.map((id) => this.cbs.get(id) ?? this.held.get(id)).filter((cb): cb is FrameCb => !!cb);
    ids.forEach((id) => (this.cbs.delete(id), this.held.delete(id)));
    cbs.forEach((cb) => cb(0, { mediaTime }));
  }
  /** Present frame f of a whole-ms 60 fps file: the counter moves, then callbacks fire. */
  present(f: number) {
    this.frames++;
    this.t = Math.round((f / 60) * 1000) / 1000;
    this.fire(this.t);
  }
  finishSeek() {
    this.seeking = false;
    this.dispatchEvent(new Event('seeked'));
  }
}

function setup() {
  const video = new FakeVideo();
  const player = new StepController(video as unknown as HTMLVideoElement, () => {});
  const est = () => player.view().estimate;
  const playFrames = (from: number, to: number) => {
    for (let f = from; f <= to; f++) video.present(f);
  };
  return { video, player, est, playFrames };
}

function expectSnappedTo60(est: ReturnType<ReturnType<typeof setup>['est']>) {
  expect(est.status).toBe('snapped');
  expect(est.d).toBe(1 / 60);
  expect(est.dMin).toBeGreaterThan(0.015);
}

describe('C(a) — a stale callback after a seek does not seed a bogus gap', () => {
  it('the Safari case: a callback for the old position (0.49792 s) right after a seek, then normal frames', () => {
    const { video, player, est, playFrames } = setup();
    player.play();
    playFrames(0, 29); // last frame shown: 0.483 s
    const stale = video.holdPending();
    player.seekTo(30.5 / 60); // the seek bar, from an old position between frames
    video.fire(0.49792, stale); // the old registration fires for the old position
    video.finishSeek();
    playFrames(30, 299); // 0.500 s on: 2.08 ms after the stale time
    expectSnappedTo60(est());
    expect(est().E).toBe(0.001); // no off-grid time was counted
  });

  it('generation counter: a pre-seek registration firing late, mid-run, for the old frame', () => {
    const { video, player, est, playFrames } = setup();
    player.play();
    playFrames(0, 60); // 1 s: not yet snapped
    expect(est().status).toBe('measuring');
    const stale = video.holdPending();
    player.seekTo(10.5 / 60);
    video.finishSeek();
    playFrames(10, 11); // the run's first callback, then its anchor
    video.fire(1.0, stale); // the old frame, 1 s ahead — would be an 817 ms gap
    playFrames(12, 299);
    expectSnappedTo60(est());
  });

  it('first callback of a run: after a seek it reports the target, 10 ms before the first frame', () => {
    const { video, player, est, playFrames } = setup();
    player.play();
    playFrames(0, 20);
    player.seekTo(0.49);
    video.finishSeek();
    video.fire(0.49); // the fresh registration's first callback: not a presented frame
    playFrames(30, 299); // 0.500 s on — a 10 ms gap would halve d_min
    expectSnappedTo60(est());
  });

  it('floor at 1/240 s − 1 ms: a callback 2.08 ms after the previous one, mid-run', () => {
    const { video, player, est, playFrames } = setup();
    player.play();
    playFrames(0, 50);
    video.fire(Math.round((50 / 60) * 1000) / 1000 + 0.00208);
    playFrames(51, 299);
    expectSnappedTo60(est());
  });
});
