// The page: file pick, playback controls, step keys and buttons, and the readout.
import { webPlatform } from './platform-web';
import { StepController, type Dir } from './step';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const playBtn = $<HTMLButtonElement>('play');
const seek = $<HTMLInputElement>('seek');
const back = $<HTMLButtonElement>('back');
const fwd = $<HTMLButtonElement>('fwd');
const readout = $<HTMLDivElement>('readout');
const nameEl = $<HTMLSpanElement>('name');

let loaded = false;
let scrubbing = false;

const MESSAGES = {
  noCallback: 'this browser cannot step frames (no requestVideoFrameCallback)',
  measuring: 'measuring frame rate…',
  uncertain: 'frame rate uncertain',
  unsupported: 'frame rate higher than this display can show; stepping not supported yet',
} as const;

const player = new StepController(video, render);

webPlatform($<HTMLInputElement>('file'), $<HTMLElement>('drop')).onFile((file) => {
  // Reset in the same task, before the new src (§2.3 "Reset on a new file").
  player.reset();
  loaded = true;
  nameEl.textContent = file.name;
  video.src = file.url;
  render();
});

function render(): void {
  const v = player.view();
  const est = v.estimate;
  const stepOn = loaded && v.enabled;

  playBtn.disabled = !loaded;
  playBtn.textContent = video.paused ? 'Play' : 'Pause';
  seek.disabled = !loaded || !Number.isFinite(video.duration);
  back.disabled = fwd.disabled = !stepOn;
  if (Number.isFinite(video.duration)) seek.max = String(video.duration);
  if (!scrubbing) seek.value = String(video.currentTime);

  let message = '';
  if (v.noCallback) message = MESSAGES.noCallback;
  else if (loaded && est.status !== 'snapped') message = MESSAGES[est.status];

  const dMs = est.d === null ? '' : String(est.d * 1000);
  const mt = Number.isFinite(v.lastMediaTime) ? v.lastMediaTime : null;
  readout.textContent = [
    `frame ${v.k}`,
    `media time ${mt === null ? '–' : mt.toFixed(6) + ' s'}`,
    `d ${est.d === null ? '–' : (est.d * 1000).toFixed(4) + ' ms'}`,
    message,
  ]
    .filter(Boolean)
    .join('  ·  ');

  const data = readout.dataset;
  data.frame = String(v.k);
  data.mediaTime = mt === null ? '' : String(mt);
  data.dMs = dMs;
  data.dSnapped = String(est.status === 'snapped');
  data.pending = String(v.pending);
  // Measurement attributes, beyond §2.3's list, for the gate's timing report.
  data.status = v.noCallback ? 'no-callback' : est.status;
  data.n = String(est.N);
  data.gaps = String(est.gaps);
  data.runs = String(est.R);
  data.deltaT = est.deltaT === null ? '' : String(est.deltaT);
  data.quantum = String(est.E);
}

playBtn.addEventListener('click', () => player.togglePlay());
back.addEventListener('click', () => player.step(-1));
fwd.addEventListener('click', () => player.step(1));

seek.addEventListener('pointerdown', () => (scrubbing = true));
window.addEventListener('pointerup', () => (scrubbing = false));
seek.addEventListener('input', () => player.seekTo(Number(seek.value)));

video.addEventListener('timeupdate', render);
video.addEventListener('durationchange', render);

const STEP_KEYS: Record<string, Dir> = { '.': 1, ArrowRight: 1, ',': -1, ArrowLeft: -1 };

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || !loaded) return;
  const dir = STEP_KEYS[e.key];
  if (dir !== undefined) {
    // Also keeps a focused seek bar from moving on the arrow keys.
    e.preventDefault();
    player.step(dir);
  } else if (e.key === ' ') {
    // Also keeps a focused button from clicking on space.
    e.preventDefault();
    player.togglePlay();
  }
});

render();
