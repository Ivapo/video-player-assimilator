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

- **Frame duration** (decision, recorded, review round 7).
  - **Collecting gaps.** The player keeps one `requestVideoFrameCallback` registered for
    the life of the video. Each call records the presented frame's `mediaTime` as
    `lastMediaTime`.
  - **Counted gaps.** Only a gap between two consecutive callbacks within one **run**
    counts: a stretch of playback with no pause, seek or `ended` in between. Each of
    those events ends the current run, and the next callback starts a new one. A gap of
    1 ms or less is ignored.
  - **`d_min`.** It is the smallest counted gap seen so far, used only as a unit for
    counting frames.
  - **Frames per gap.** A counted gap `g` covers `n_g = round(g / d_min)` frames, where a
    skipped callback makes `n_g` ≥ 2. The count is exact while every gap is within half
    a frame of a whole number of `d_min`s. With whole-ms timestamps at 60 fps, that
    holds for skips of up to 7 frames.
  - **The estimate.** `d_est = S / N`, where `S` is the sum of the counted gaps and `N`
    is the sum of their `n_g`. `S` telescopes to the sum of each run's span, from its
    first callback to its last. So `S` is off by at most `2·(E/2)` per run from rounded
    timestamps, and `d_est` is off by at most `ε = R·E / N`, where `R` is the number of
    runs.
  - **The quantum `E`** is how coarsely `mediaTime` is recorded. It is the largest `q` in
    {100 ms, 10 ms, 1 ms} such that every counted `mediaTime` is within 1 µs of a
    multiple of `q`. If there is none, `E = 1 µs`, which covers Chrome's µs rounding
    (measured, round 5). Safari reports the full double (measured, round 6), so for it
    1 µs is conservative.
    - An mp4 remuxed from mkv or webm has whole-ms timestamps, so `E = 1 ms` (round 6,
      R6-B1).
    - A file whose frame times are exact multiples of 10 ms, such as 25 or 50 fps, also
      gets `E = 10 ms`, whatever its container. That only slows the snap.
  - **Reset.** The estimate (runs, `S`, `N`, `d_min`, `E`, `d`) is reset when a new file
    arrives (see "Reset on a new file").
- **Snapping `d` to a standard rate** (decision, recorded, rounds 6–7).
  - **The candidates** are every whole rate `n` fps and every `n × 1000/1001` fps, for
    `n` = 1…240.
  - **The rule.** Let `c` be the candidate duration nearest to `d_est`, and let `gap(c)`
    be the distance from `c` to the nearest *other* candidate. The estimate snaps when
    both hold:
    - it is unambiguous: `ε < gap(c) / 2`;
    - it fits: `|d_est − c| ≤ ε`.

    Then `d = c` exactly, `1/n` or `1001/(1000·n)`, and estimation stops. Because the
    true duration is within `ε` of `d_est`, and every other candidate is more than `ε`
    from it, a snapped `d` is the file's own rate.
  - **When it snaps.** The 60 vs 59.94 fps pair sets the bound for 60 fps content:
    `gap = 16.667 µs`, so it needs `ε < 8.333 µs`.
    - With µs timestamps (`E = 1 µs`, `R = 1`) that holds from the first 10 gaps.
    - With whole-ms timestamps (`E = 1 ms`, `R = 1`) it needs `N ≥ 121` frames, about
      **2.02 s** of playback.
    - In general, the n vs n×1000/1001 pair is `d/1000` apart. So with `E = 1 ms` a
      snap needs more than `2 s × R` of playback at any rate up to 240 fps; with
      `E = 10 ms`, more than `20 s × R`.
    - Measured on the whole-ms 60 fps fixture (review round 7, author): the estimate
      snaps to 60 fps at `N = 121` from every start frame. The worst `|d_est − 1/60|` over
      all start frames is 5.5 µs, against `ε` = 8.26 µs.
  - **Drift bound, snapped.** `d` equals the rate's exact duration. The step target
    `(k + 0.5)·d` differs from the true middle of frame `k` only by the container's
    rounding of that frame's timestamp, at most `E/2` (0.5 ms for whole-ms files). That
    error does not grow with `k`, and it stays under the half-frame margin whenever
    `E < d`. There is no drift at any file length.
  - **Drift bound, not snapped** (step enabled at the cap, see below). `|d − true| ≤ ε`
    at the moment step is enabled. The target for frame `k` lands in frame `k` while
    `k·ε + E/2 < d/2`, that is, for `k < (d − E) / (2ε)`.
    - A 300 fps whole-ms file after the 30 s cap: `N` = 9 000 and `ε` = 0.11 µs, so this
      holds for `k` < 10 500 frames, about 35 s.
    - A variable-rate file has no true `d`, so the bound does not apply (OQ-2).
    - The bound is stated per file. The earlier claim that a rate which does not snap
      "is above 240 fps or variable" was false (round 6, R6-B1) and is withdrawn.
  - **When `d` changes** (a later snap, or the estimate moving while step is already
    enabled uncertain), `kValid` becomes false, so the next step snaps first.
- **When step is enabled** (decision, recorded, review round 7).
  - **Before `d` snaps:** the step buttons and keys are disabled, and the readout says
    "measuring frame rate…". The estimate is taken while the video plays, whether or not
    the user started playback. Nothing plays on the user's behalf.
  - **At the snap:** step is enabled.
  - **At the cap:** if the estimate has not snapped after **30 s of counted playback**,
    or at `ended`, whichever comes first, step is enabled with `d = d_est`.
    `d_est` must rest on at least 10 counted gaps. The readout then shows the visible
    note "frame rate uncertain".
    - 30 s covers a snap with `E = 10 ms` and one run (> 20 s).
    - A clip too short to give 10 counted gaps keeps step disabled.
    - Estimation continues after the cap, and a later snap clears the note.
- **Player state** (decision, recorded, review round 6). The step logic decides from
  state the player owns. `video.seeking` is never a pending signal: its only use is the
  guard in the `seeked` handler below. The state is:
  - `k`: the frame index;
  - `kTime`: the `currentTime` read when `k` was last set;
  - `kValid`: "k valid";
  - `pending`;
  - `ownPaused`: the player's own record of whether the video is paused;
  - one FIFO `queue` of step presses.
- **Reset on a new file** (review round 7, from round 6 N4). When `onFile` fires, the
  player resets all of its state in the same task, before it sets the new `src`:
  - `queue` is emptied, `pending = false`, `kValid = false`, `k = 0`, `kTime = NaN`;
  - `ownPaused = true`, since a newly loaded video is paused and nothing autoplays;
  - the whole frame-duration estimate is cleared (`d` unset, step disabled).

  This covers a file arriving mid-seek, whose old seek never fires `seeked`. Setting
  `src` runs the media element load algorithm, which drops the element's queued tasks
  (HTML spec, stated from memory, check). As a guard, the `seeked` handler ignores any
  event while `d` is unset.
- **The frame index `k`.** It is set in exactly two ways:
  1. A step sets `k = clamp(k ± 1, 0, last)`, where `last = round(duration / d) − 1`.
     For the fixture that is `round(90.0 ± ε) − 1 = 89`; `floor` would give 88 when
     floating point comes out just under 90.
  2. The `seeked` handler sets `k = clamp(floor(currentTime / d + 0.001), 0, last)` and
     `kTime = currentTime`. The `+ 0.001` frame is an epsilon, so a seek landing exactly
     on the boundary `k·d` reads as `k` and not `k − 1` when floating point comes out
     just under it. For a mid-frame target, `(k + 0.5)·d`, the epsilon changes nothing.
     This applies to every seek, whoever started it: a step, the snap, a scrub, or a
     script.

  Nothing reads `lastMediaTime` to set `k`. `lastMediaTime` feeds only the estimate of
  `d` and the readout.
- **`kValid`.** It is true only once a `seeked` handler has set `k`. It becomes false in
  four cases:
  - The player starts a seek: a step, the snap, or its own seek bar.
  - Playback starts: the player's own `play()` call, or any `play` event.
  - A `pause` or `ended` event arrives that the player did not cause.
  - A step finds that the video has moved without the player knowing. That is,
    `video.paused !== ownPaused`, or `video.currentTime !== kTime`. The step then sets
    `ownPaused = video.paused`. The second check catches a script's seek in the same
    task, before any event arrives.
- **`pending`.** It is set when the player itself sets `currentTime` (a step, the snap,
  or its seek bar). It is cleared only in the player's `seeked` handler. The keyboard
  and button handlers decide whether to queue a step press from `pending` alone.
- **The `seeked` handler.**
  - If `video.seeking` is true when `seeked` is dispatched, a newer seek is already in
    flight, and the handler returns and waits for that seek's `seeked`. Chrome fires two
    `seeked` events when a second seek starts after `seeking` has gone false (round 5,
    measured). This is the only place the player reads `video.seeking`. It is not a
    pending signal.
  - Otherwise the handler sets `k` and `kTime` by rule 2, sets `kValid = true` and
    `pending = false`. It then takes the head of `queue`, if there is one, and handles
    it as a fresh step press.
- **The snap.** It puts the picture on the middle of the frame the video stopped on, so
  that the screen and `k` agree before a step uses `k`.
  - **The seek:** `t = video.currentTime`, read while the video is paused. The target
    is `(clamp(floor(t / d + 0.001), 0, last) + 0.5)·d`. The snap sets `pending` and
    clears `kValid`, like any seek the player starts.
  - **When it happens:** at the player's own `pause()` call site, in the same task. That
    covers the play/pause button, space, and a step pressed while playing. It also
    happens inside a step that finds `kValid` false.
  - **A pause the player did not cause** does not snap by itself. Examples: an OS media
    key, a script, or the end of the media, where browsers fire `pause` and then
    `ended`. Its event handler only sets `ownPaused = true` and `kValid = false`, and
    the next step snaps. At the end of the media, `t = duration`, so the clamp sends the
    snap to `last`. A script seek that follows a foreign pause (for example the gate's
    `video.pause()` and then a seek) is not raced by a snap.
  - **Why `t = currentTime` and not `lastMediaTime`:** `currentTime` can be read in the
    same task as the pause. The frame callback for the last frame before a pause can
    arrive late or not at all (round 4, non-blocking). Either value can be one frame
    off the screen; round 5 measured `currentTime` one frame behind in Chrome. The cost
    is the same either way: the picture moves when playback stops. `k` is right either
    way, because the snap's `seeked` sets `k` from the frame it seeked to, and that is
    the frame then shown.
  - **Known, accepted behaviour (round 6, N2):** in Safari, `currentTime` right after
    `pause()` was measured ~6 frames behind the latest `mediaTime` (one sample). So on
    Safari the picture can jump back several frames when playback stops. `k` still
    matches the frame shown after the snap, which is what stepping depends on.
- **Play and pause presses** are never queued. They act at once, even while `pending`
  is set. A pause during a pending seek snaps, and that snap replaces the pending seek.
- **The step** (a `.`/`,` press or a button, or the head of `queue`):
  1. If `pending` is set, append the press to the tail of `queue` and stop.
  2. Run the moved-without-knowing check (see `kValid`).
  3. If `kValid` is false: if the video is playing, call the player's own `pause()`,
     which snaps. Otherwise snap. Then put the ±1 at the **head** of `queue`, ahead of
     presses already waiting, because it is the oldest press. Stop.
  4. Otherwise set `k = clamp(k ± 1, 0, last)`, set `kValid = false` and
     `pending = true`, and set `currentTime` to `(k + 0.5)·d`. The half-frame offset
     aims at the middle of the frame, so a rounding error cannot land on the neighbor.
     Setting `currentTime` always runs a seek and fires `seeked`, even when the target
     equals the current position, as it does at a clamp.
- **Where the callback is missing** (Phase 1, OQ-1): step is disabled for good, and the
  readout says the browser cannot step frames. There is no typed frame rate in Phase 1.

The readout shows the frame index `k`, `lastMediaTime` in seconds, and `d` in ms, plus
"measuring frame rate…" or "frame rate uncertain" when they apply. The readout element
carries `data-frame`, `data-media-time`, `data-d-ms`, `data-d-snapped` and
`data-pending` (the player's `pending` flag) attributes, which the browser test reads.

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

**Fixtures.** `scripts/make-fixture.sh` writes two files into `test/fixtures/`. The
generator is committed; the videos are git-ignored. Both files are 640×360 and made from
`testsrc`, encoded with `-c:v libx264 -pix_fmt yuv420p -r <rate>`. The default encode of
`testsrc` is yuv444p (High 4:4:4), which browsers do not decode.

- **`frames.mp4`**: 30 fps, 3 s, 90 frames numbered 0–89, written straight to mp4. Its
  timestamps are exact; the time base is 1/15360.
- **`frames60ms.mp4`**: 60 fps, 5 s, 300 frames numbered 0–299, with **whole-ms
  timestamps** (round 6, R6-B1). The script first encodes to `frames60.mkv`, whose
  Matroska time base is 1 ms. It then remuxes with
  `ffmpeg -i frames60.mkv -c copy -video_track_timescale 1000 frames60ms.mp4`.
  Measured in review round 7 by the author:
  - ffprobe reports `time_base=1/1000`, `r_frame_rate=60/1`, `nb_frames=300` and
    duration 4.999 s;
  - every presentation timestamp is a whole ms (0, 0.017, 0.033, 0.050 …);
  - the gaps are only 16 ms and 17 ms;
  - `last = round(4.999·60) − 1 = 299`.

Two marks are drawn on every frame of both files:

- **For the script:** a 360×40 black bar in the top-left corner holds 9 bit cells,
  enough for 0–511. Cell `b` is a 32×32 box at `x = 40·b + 4`, `y = 4`, and it is white
  when bit `b` of the frame number `n` is set. The drawing is
  `drawbox=…:enable='eq(mod(floor(n/2^b),2),1)'`. Stock ffmpeg has `drawbox`.
  Measured: every frame decodes back to its own index, all 90 (7 cells, round 1) and
  all 300 of `frames60ms.mp4` (9 cells, round 7).
- **For the eye:** `drawtext` with `text='%{n}'` (0-based) and
  `fontfile=/System/Library/Fonts/Supplemental/Arial.ttf`. The Homebrew `ffmpeg` bottle
  has no `drawtext`, because it is built without libfreetype, but `ffmpeg-full` has it.
  The script uses `$FFMPEG`, which defaults to `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`.
  If that binary has no `drawtext`, the script exits with an error that says
  `brew install ffmpeg-full`.

**Reading a frame.** The test draws the `<video>` to a canvas with `drawImage` and
samples each cell's center pixel. A cell is set when its luma is above 128, and the
nine bits give the frame number. This reads the pixels the player shows, not what the
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
  holds the frame-duration estimate and snap, the enable rule and the cap, the reset
  on a new file, the step, and the no-callback case (§2.3). Forward and back step by key and by button.
  The readout (§2.3) and the constant-rate note (§2.4). The generator for both fixtures and
  both browser runs (§2.6). `vite.config.ts` with the Pages `base`, and the Pages workflow
  (§2.5).
- **Exit gate:** in both Chrome and Safari (§2.6), on both fixtures, a browser test does
  the following.

  **A. `frames.mp4`** (30 fps, frames 0–89, exact timestamps):
  1. Load the file. Assert step is disabled.
  2. Play for at least 1 s. Assert that `d` has snapped to exactly `1/30`
     (`data-d-snapped` is true, and `data-d-ms` is 33.333…).
  3. Pause. Seek to `10.5/30` s and wait for `seeked`. Read frame 10 from the pixels.
  4. Press `.` 5 times; read frame 15. Press `,` 7 times; read frame 8.
  5. Seek to `0.5/30` s. Press `,` once; read frame 0 (clamped).

  **B. `frames60ms.mp4`** (60 fps, frames 0–299, whole-ms timestamps):
  1. Load the file. Play for 1 s. Assert step is **still disabled** and the readout
     says "measuring frame rate…". At about 60 frames, `ε` ≈ 16.7 µs, which is not
     below 8.33 µs.
  2. Keep playing, to at least 3 s in total. Assert `d` has snapped to exactly `1/60`.
     The snap needs 121 frames, about 2.02 s.
  3. Pause. Seek to `10.5/60` s. Press `.` 40 times, reading the pixels after **every**
     press: frames 11, 12, … 50.
  4. Seek to `250.5/60` s. Press `,` 40 times, reading after every press: frames 249 …
     210. With the round-6 `d_m` = 16 ms, every one of these reads would be wrong.
  5. Seek to `299.5/60` s. Press `.` once; read frame 299 (clamped at `last`).

  "Read" means the pixel bit-strip decode (§2.6). The test sends one key and waits for
  the readout's `data-frame` to hold the expected index and for no seek to be pending.
  Then it waits one `requestVideoFrameCallback` on its own side, or 100 ms if none fires
  (the clamp case), before it reads the pixels. The Chrome run then repeats A.1–A.4
  against the deployed Pages URL, which proves the deploy serves the working player and
  not just a page.
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
