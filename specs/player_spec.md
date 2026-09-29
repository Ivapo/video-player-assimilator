---
id: vpa-001
title: player
note: >
  What the player is for: the user picks an mp4 file, it plays, and the user can step it one
  frame at a time. Phase 1 is the smallest surface that produces that: a static web page.
status: draft
last_updated: 2026-09-28

phases:
  - name: "Phase 1 — Web player with frame-by-frame step"
    reviewed: null
    shipped: null
    cut: null
    by: null

extends: null
supersedes: null
superseded_by: null
related: []
reference: >
  Seed brief: ~/dev/ivapo/video-player-assimilator/idea.md (the idea, the decisions so far,
  the open questions). Out of scope from it: playing formats the browser cannot play
  (`ffmpeg.wasm`, `libmpv`), and upload or share links.
---

# Player

## 1. Goal

A simple video player under the Assimilator brand. A person picks a video file on their own
device and watches it. What a basic player or a Chrome tab does not give them is
frame-by-frame step, so that is the first feature.

**The observable is a video frame on screen: the user picks an mp4 file, the player plays
it, and the user can step it one frame at a time.**

Rejected candidates for the observable:
- *A static site and a desktop installer.* They are what we ship, not what the user sees.
- *The platform layer (browser file input, Tauri dialog).* It is how a file arrives, not
  something anyone watches. Phase 2 of the roadmap (§2.7) touches it and must say so.

### 1.1 Non-goals

- No upload, no server, no share links. The file stays on the user's device.
- No playback of formats the system webview cannot play. No `ffmpeg.wasm`, no `libmpv`.
- No fix for missing codecs on Linux. Linux users install their own GStreamer plugins.
- No editing, no export, no playlists.

## 2. Design

### 2.1 Stack (decision, recorded in `idea.md`)

TypeScript, Vite, and Tauri. Playback uses the browser `<video>` tag. Web and desktop
share one `src/`. A small platform layer has two implementations: the browser file input
for web, the Tauri dialog and file-open events for desktop. No UI framework at first.

### 2.2 Getting a file on the web

An `<input type="file" accept="video/mp4">` and drag-and-drop. The file becomes a
`URL.createObjectURL` link that is the `src` of the `<video>` tag. The link is revoked when
the user picks another file.

The platform layer is one interface in `src/platform.ts`:

```ts
export interface PickedFile { url: string; name: string }
export interface Platform { onFile(cb: (file: PickedFile) => void): void }
```

`src/platform-web.ts` implements it with the file input and drag-and-drop, and owns the
revoke. Phase 2 adds a Tauri implementation of the same interface, whose `onFile` also fires
for file-open events. In a dev build only (`import.meta.env.DEV`), the web implementation
also fires `onFile` once for a `?src=<url>` query parameter; the Safari test (§2.6) needs
it, and a production build does not contain it.

### 2.3 Frame-by-frame step

A `<video>` tag has no "next frame" call and does not expose the frame rate. Two parts:

Frames are numbered from 0: with frame duration `d`, frame `k` covers
`[k·d, (k+1)·d)`.

- **Frame duration.** Read it from `requestVideoFrameCallback`. The player keeps one
  callback registered for the life of the video, and each call records the presented
  frame's `mediaTime` as `lastMediaTime`. While the video plays, the gap between two
  consecutive `mediaTime`s is one frame, or a whole multiple of one when a frame was
  skipped. After 10 gaps have been collected, the estimate is `d` = the smallest gap
  greater than 1 ms. Taking the minimum is what makes skipped callbacks harmless. The
  estimate is reset when a new file arrives.
- **Before an estimate exists.** The step buttons and keys are disabled, and the readout
  says "play to measure frame rate". The estimate is taken the first time the video
  plays, whether the user starts that playback or it plays for any other reason. Nothing
  plays on the user's behalf.
- **The frame index `k`** (decision, recorded, review round 5). The player keeps `k` as
  its own state. It is set in exactly two ways:
  1. A step sets `k = clamp(k ± 1, 0, last)`, where `last = round(duration / d) − 1`.
     For the fixture that is `round(90.0 ± ε) − 1 = 89`; `floor` would give 88 when
     floating point comes out just under 90.
  2. Every `seeked` event, whoever started the seek, sets
     `k = clamp(floor(currentTime / d + 0.001), 0, last)`. The `+ 0.001` frame is an
     epsilon, so a seek landing exactly on the boundary `k·d` reads as `k` and not `k − 1`
     when floating point comes out just under it. For a mid-frame target, `(k + 0.5)·d`,
     the epsilon changes nothing.

  Nothing reads `lastMediaTime` to set `k`. `lastMediaTime` feeds only the estimate of `d`
  and the readout.
- **Pending.** A seek is pending while `video.seeking` is true, whoever started it: a
  step, the snap below, a scrub, or a script. It ends at the next `seeked`. A seek
  started during another replaces it, and the browser fires one `seeked` for the last
  one. Setting `currentTime` always runs a seek and fires `seeked`, even when the target
  equals the current position, as it does at a clamp. Presses made while a seek is
  pending go into one queue. After each `seeked` has set `k`, the head of the queue is
  taken out and handled as if it had just been pressed, so it may itself start a seek
  and wait again.
- **The snap.** When playback stops, the player seeks to the middle of the frame the
  video stopped on, so the picture on screen and `k` agree before any step uses `k`.
  The target is `(clamp(floor(t / d + 0.001), 0, last) + 0.5) · d`, with
  `t = video.currentTime` read right after `pause()`. The snap is a pending seek like any
  other, and its `seeked` sets `k` by rule 2.
  - **Why `currentTime` and not `lastMediaTime`:** `currentTime` can be read in the same
    call that pauses the video. `lastMediaTime` depends on a frame callback, and the
    callback for the last frame before a pause can arrive late or not at all (round 4,
    non-blocking note). So `lastMediaTime` can be one frame stale at the moment of the
    snap. `currentTime` can also disagree with the frame on screen by up to one frame.
    The cost of either error is the same: the picture moves by one frame when playback
    stops. `k` is right either way, because the snap's `seeked` sets `k` from the frame
    it seeked to, and that is the frame then shown.
  - **Where it starts.** For a pause the player makes itself (the play/pause button,
    space, or a step pressed while playing), the snap starts at the player's own
    `pause()` call, in the same task. It does not wait for the `pause` event. The player
    counts its own `pause()` calls made while the video was playing. Each such `pause`
    event uses up one count and does nothing more.
  - **A `pause` event the player did not cause**, such as an OS media key or a script,
    snaps only when no seek is pending (`video.seeking` is false). When a seek is already
    in flight, that seek's `seeked` sets `k`.
  - **`ended`.** The snap goes to the last frame, `(last + 0.5) · d`, unless a seek is
    already pending. Browsers fire `pause` before `ended` at the end of the media, and
    that `pause` is not the player's own, so it may already have started the snap. The
    clamp in the target sends that snap to `last` as well.
- **The step.** When the video is paused and no seek is pending: set
  `k = clamp(k ± 1, 0, last)`, then set `currentTime` to `(k + 0.5) · d`. The half-frame
  offset aims at the middle of the frame, so a rounding error cannot land on the
  neighbor. When a seek is pending, the press is queued. When the video is playing, the
  step pauses it, which starts the snap, and the ±1 is queued behind the snap.
- **Where the callback is missing** (Phase 1, OQ-1): step is disabled for good, and the
  readout says the browser cannot step frames. There is no typed frame rate in Phase 1.

The readout shows the frame index `k`, `lastMediaTime` in seconds, and `d` in ms. The
readout element carries `data-frame`, `data-media-time`, `data-d-ms` and `data-pending`
attributes, which the browser test reads.

Keys: `.` and right arrow step forward, `,` and left arrow step back, space plays and
pauses. Buttons do the same.

### 2.4 Files with a variable frame rate

For a variable-rate video, one fixed frame duration is wrong. Phase 1 shows a fixed
note beside the step buttons: "Steps assume a constant frame rate". It does not detect
variable-rate files, and it steps by the estimated duration. It does not try to be
exact (OQ-2).

### 2.5 Hosting

`vite build` writes static files. They deploy to GitHub Pages. No headers or server
settings are needed, because there is no `SharedArrayBuffer` and no wasm.

The site is served at `https://ivapo.github.io/video-player-assimilator/`, so
`vite.config.ts` sets `base: '/video-player-assimilator/'`. A workflow at
`.github/workflows/pages.yml` builds on every push to `main` and deploys with
`actions/deploy-pages`. Pages is not enabled on the repo yet. Enabling it once, with
source "GitHub Actions", is a manual step for the repo owner and is part of Phase 1.

### 2.6 Test fixture and harness (decision, recorded)

**Fixture.** `scripts/make-fixture.sh` writes `test/fixtures/frames.mp4`. The generator
is committed; the video is git-ignored. It makes a 30 fps, 3 s, 640×360 file of 90
frames, numbered 0–89, from `testsrc`. It encodes with `-c:v libx264 -pix_fmt yuv420p
-r 30`. The default encode of `testsrc` is yuv444p (High 4:4:4), which browsers do not
decode. Two marks are drawn on every frame:

- **For the script:** a 320×40 black bar in the top-left corner holds 7 bit cells. Cell
  `b` is a 32×32 box at `x = 40·b + 4`, `y = 4`, and it is white when bit `b` of the
  frame number `n` is set. The drawing is
  `drawbox=…:enable='eq(mod(floor(n/2^b),2),1)'`. Stock ffmpeg has `drawbox`. Measured
  in review round 1: every one of the 90 frames decodes back to its own index.
- **For the eye:** `drawtext` with `text='%{n}'` (0-based) and
  `fontfile=/System/Library/Fonts/Supplemental/Arial.ttf`. The Homebrew `ffmpeg` bottle
  has no `drawtext`, because it is built without libfreetype, but `ffmpeg-full` has it.
  The script uses `$FFMPEG`, which defaults to `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`.
  If that binary has no `drawtext`, the script exits with an error that says
  `brew install ffmpeg-full`.

**Reading a frame.** The test draws the `<video>` to a canvas with `drawImage` and
samples each cell's center pixel. A cell is set when its luma is above 128, and the
seven bits give the frame number. This reads the pixels the player shows, not what the
player believes it shows.

**Harness.** Two runners, one spec file of steps shared between them:
- **Chrome:** Playwright Test with `channel: 'chrome'`, which is the installed Google Chrome.
  Playwright's bundled Chromium is not used, because it lacks the H.264 decoder. The
  file arrives through the real file input (`setInputFiles`).
- **Safari:** the real Safari.app, not Playwright WebKit. The test drives it through
  `safaridriver` with WebdriverIO. It needs a one-time `safaridriver --enable` and
  Develop → "Allow Remote Automation". `safaridriver` cannot set a file input, so this
  run loads the fixture with the dev-only `?src=` parameter (§2.2) against `vite dev`.
  The file-input path is covered by the Chrome run.

### 2.7 Roadmap after Phase 1

Phase 2 wraps the same `src/` in Tauri and adds the file-open path. Phase 3 is the next
extra feature (OQ-4). Each is a phase in this spec or a new spec; §6.1's ordered test
decides which.

## 3. Open questions

- **OQ-1** — ~~When `requestVideoFrameCallback` is missing, is a typed frame rate enough, or
  do we refuse to step?~~ **RESOLVED for Phase 1** (review round 1): refuse to step, and
  say why (§2.3). A typed frame rate is not built. The callback is in Chrome 83+,
  Safari 15.4+ and Firefox 132+, so it is missing only in old browsers. That list is
  from the reviewer's memory and has not been checked against a compatibility table;
  check it before relying on it. Reopen this question only if a supported browser
  turns out to lack the callback. *(design call)*
- **OQ-2** — For variable-frame-rate files, do we step by the estimated duration, or walk
  the callback times (step by seeking, then read the next presented `mediaTime`)? *(design
  call, deferred by evidence: measure on a real file first. Does not block Phase 1, which
  steps by the estimate and shows the fixed note in §2.4.)*
- **OQ-3** — The Assimilator brand name and look for this player. *(needs-input)*
- **OQ-4** — Which extra feature comes after frame step: loop a section, speed control,
  or overlays? *(needs-input)*
- **OQ-5** — Does "Open with" file association belong in the first desktop phase?
  *(needs-input)*

## 4. Implementation phases

Strictly sequential; each is one plan-mode pass.

### Phase 1 — Web player with frame-by-frame step
*Produces the observable: yes — a user picks an mp4 file in the browser, it plays, and they
step it frame by frame.*

- **Scope:** a Vite and TypeScript project with a single page: `index.html` and
  `src/main.ts` (the UI and key bindings). File input and drag-and-drop through the
  platform interface (§2.2): `src/platform.ts` and `src/platform-web.ts`, the browser
  implementation only. A `<video>` element with play, pause and seek. `src/step.ts`
  holds the frame-duration estimate, the step, the disabled state before an estimate
  exists, and the no-callback case (§2.3). Forward and back step by key and by button.
  The readout (§2.3) and the constant-rate note (§2.4). The fixture generator and both
  browser runs (§2.6). `vite.config.ts` with the Pages `base`, and the Pages workflow
  (§2.5).
- **Exit gate:** in both Chrome and Safari (§2.6), with `test/fixtures/frames.mp4`
  (frames 0–89), a browser test does this:
  1. Load the file. Assert step is disabled.
  2. Play for at least 1 s. Assert the estimated `d` is within 1 ms of 33.33 ms.
  3. Pause. Seek to `10.5/30` s and wait for `seeked`. Read frame 10 from the pixels.
  4. Press `.` 5 times; read frame 15. Press `,` 7 times; read frame 8.
  5. Seek to `0.5/30` s. Press `,` once; read frame 0 (clamped).

  "Read" means the pixel bit-strip decode (§2.6). The test sends one key and waits for
  the readout's `data-frame` to hold the expected index and for no seek to be pending.
  Then it waits one `requestVideoFrameCallback` on its own side, or 100 ms if none fires
  (the clamp case), before it reads the pixels. The Chrome
  run then repeats steps 1–4 against the deployed Pages URL, which proves the deploy
  serves the working player and not just a page.
- **Manual one-time setup** (not code): install `ffmpeg-full`; enable Pages with source
  "GitHub Actions"; run `safaridriver --enable` and turn on "Allow Remote Automation".
- **Close-out:** seed `rules/player.md` (the stack, the platform layer, the step
  algorithm). Commit the test file generator, not the video (git-ignore
  `test/fixtures/*.mp4`). Write `shipped` after the gate
  passes.

<!--
The review record is a sibling file, not a section: it lives at
specs/reviews/<id>.md, append-only, one heading per round. See §7.
-->
