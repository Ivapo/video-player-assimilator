---
id: vpa-001
title: player
note: >
  What the player is for: the user picks an mp4 file, it plays, and the user can step it one
  frame at a time. Phase 1 is the smallest surface that produces that: a static web page.
  Phase 2 wraps the same page in a Tauri desktop app with "Open with".
status: accepted
last_updated: 2026-09-29

phases:
  - name: "Phase 1 — Web player with frame-by-frame step"
    reviewed: 2026-09-28
    shipped: 2026-09-29
    cut: null
    by: null
  - name: "Phase 2 — Desktop app"
    reviewed: null
    shipped: null
    cut: null
    by: null

extends: null
supersedes: null
superseded_by: null
related: []
reference: >
  Seed brief: ~/dev/ivapo/Orchtr-video-player-asmltr/idea.md (the idea, the decisions so far,
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

*(2026-09-29, Phase 2.)* The Tauri implementation is designed in §2.8–§2.10. The interface
does not change.

### 2.3 Frame-by-frame step

A `<video>` tag has no "next frame" call and does not expose the frame rate. Two parts:

Frames are numbered from 0: with frame duration `d`, frame `k` covers
`[k·d, (k+1)·d)`.

- **Frame duration** (decision, recorded, review round 7).
  - **Collecting gaps.** The player keeps one `requestVideoFrameCallback` registered for
    the life of the video. Each call records the presented frame's `mediaTime` as
    `lastMediaTime`.
    - **Across a seek** (amended at the build by the user's decision, without a review
      round; the gate verifies it). At `seeked` and on a new file, the player replaces
      its registration with a fresh one. Each registration carries a generation number,
      and a callback whose generation is not the current one is ignored. That covers a
      replaced registration that still fires, for a pre-seek frame. (A cancel at
      `seeking` was specified at first and then removed at the build as redundant: the
      replacement at `seeked` and the first-callback rule below already cover every
      order the build tested, and no test failed without it.) Why: in one Safari run the estimate was enabled uncertain
      with `d` = 2.08 ms, from a counted gap far shorter than a frame. The build could not
      tell from its logs where that gap came from. A pre-seek callback is the suspected
      source.
  - **Counted gaps.** Only a gap between two consecutive callbacks within one **run**
    counts: a stretch of playback with no pause, seek or `ended` in between. Each of
    those events ends the current run, and the next callback starts a new one.
    - **The first callback of a run only starts it** (amended at the build). Its gap to
      the previous run's last callback is never counted, and neither is the gap from it
      to the next callback. The run's second callback is its first anchor. After a seek,
      the first callback can report a position that is not a presented frame.
    - **The floor** (amended at the build, from 1 ms). A gap shorter than
      **1/240 s − 1 ms** (3.17 ms) is ignored. Phase 1 supports rates up to the
      display's, and no candidate rate is faster than 240 fps, so no frame of a
      supported file is shorter than 1/240 s. The 1 ms allowance is for whole-ms
      timestamps: a whole-ms 240 fps file has gaps of 4 ms, which a floor of exactly
      1/240 s would drop.
    - There is deliberately no filter for gaps much shorter than `d_min`. It would
      conflict with the R7-B2 recount, which lowers `d_min` on purpose when a shorter
      real gap arrives.
  - **`d_min`.** It is the smallest counted gap seen so far, used only as a unit for
    counting frames.
  - **Frames per gap** (round 7, R7-B2). A counted gap `g` covers
    `n_g = round(g / d_min)` frames, where a skipped callback makes `n_g` ≥ 2. The player
    stores every counted gap. **Whenever `d_min` drops, it recounts `n_g` for every
    stored gap** against the new `d_min`, so `N` is never a running total built on an
    older, larger `d_min`.
    - **Long gaps** (amended at the build by the user's decision, without a review
      round; the gate verifies it). A gap longer than **7 × `d_min`** is not counted,
      because beyond that `round(g / d_min)` is no longer exact. The recount checks this
      again whenever `d_min` drops, so a gap counted under a larger `d_min` can stop
      counting. An uncounted gap ends a **segment**: `S` no longer telescopes across it,
      so in `ε = R·E/N` below, `R` is the number of segments that hold a counted gap,
      where a run is split at every gap that is not counted. `ΔT` for the cross-check is
      the sum of the counter's change over the counted gaps only.
    - Why: in one Safari run, playback stalled to about 3 frames per callback, with
      some gaps of more than 7 frames. `N` was overcounted, nothing snapped, and at
      `ended` the cap enabled step with `d` = 16.199 ms against 16.667. The count is exact while every gap is within half a frame of
    a whole number of `d_min`s. With whole-ms timestamps at 60 fps, that holds for skips
    of up to 7 frames. At most 30 s × 240 fps = 7 200 gaps are stored before the cap.
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
    - there are at least **10 counted gaps** (R7-B2);
    - it is unambiguous with margin: `ε ≤ 0.9 · gap(c) / 2` (R7-N1). The 10% margin
      means a tie such as `N = 120` at 60 fps whole-ms, where `ε` equals `gap/2`
      exactly, is never decided by floating point;
    - it fits: `|d_est − c| ≤ ε`;
    - the frame-count cross-check agrees (below).

    Then `d = c` exactly, `1/n` or `1001/(1000·n)`, and estimation stops. Because the
    true duration is within `ε` of `d_est`, and every other candidate is more than `ε`
    from it, a snapped `d` is the file's own rate. That holds *provided* `N` counts the
    file's frames, which is what the cross-check guards.
  - **Frame-count cross-check** (round 7, R7-B1).
    - **Why it is needed.** `requestVideoFrameCallback` fires at most once per
      *presented* frame. When the file's rate is at least twice what the browser
      presents, no gap is a single frame. `d_min` is then a multiple of the true
      duration, and the snap is confidently wrong. Round 7 measured this on a 60 Hz
      display: Chrome snapped 120 fps to 60, and both browsers snapped whole-ms 300 fps
      to 100. Below 2× the presented rate, some gaps are single frames, so `d_min` and
      `N` stay right.
    - **The check.** At each callback of a run, the player reads
      `video.getVideoPlaybackQuality().totalVideoFrames`, which counts decoded frames
      including dropped ones. `ΔT` is the sum, over runs, of that count at the run's
      last callback minus its count at the run's first. Snapping, and enabling at the
      cap, require `|ΔT − N| ≤ 0.1·N + 3·R`.
    - **The tolerance.** `3·R` allows up to 3 frames per run of skew between when a
      frame is counted (at decode, which runs ahead) and when it is presented. That
      figure is stated from memory and is for the build to confirm. `0.1·N` allows 10%
      proportional slack. The failure it guards against is a ratio `ΔT/N` of 2 or more,
      so a 10% band is far from both a correct count (ratio 1) and the failure. At
      N = 10 and R = 1 the band is ±4 frames, while a 2× file differs by 10. The build
      confirmed the 3-per-run figure in Chrome: on correctly counted files `ΔT − N` was
      0 to +3 with R = 1–2.
    - **Per-frame or batched counter** (build finding, amended by the user's decision
      without a review round; the gate verifies it). The check assumes the counter
      advances with each decoded frame. Safari 26.6.2 does not. It jumps by 11–30 at the
      start of playback (decode-ahead), then holds for about 2 s at a time. On
      `frames60ms.mp4` that gave `ΔT` = 17–19 against `N` = 10, so every 60 fps file was
      refused. Let `δT` be the counter's change from one counted callback to the next
      within a run.
      - **The rule.** The counter is **per-frame** once `δT ≥ 1` on 8 consecutive
        counted gaps of one run. It is **batched** once `δT = 0` on 8 consecutive
        counted gaps of one run. Whichever is seen first holds for the file, and the
        reset on a new file clears it.
      - **Until either is seen**, the check neither agrees nor disagrees. Nothing snaps,
        nothing is refused, and the cap does not enable step.
      - **Per-frame:** the check applies as above. **Batched:** the check is skipped, and
        the estimate snaps, or enables at the cap, as it would without the guard.
      - **Why 8** (measured at the build on a 60 Hz display, 3 runs per fixture, 2.5 s
        each). In Chrome, `δT` was 1–2 on every gap of `frames.mp4` and `frames60ms.mp4`,
        and 2–6 on `frames120.mp4`. It never stayed at 0 for more than 4 gaps in a row,
        and that happened only on `frames120.mp4`, after gap 10. In Safari, `δT` was 0 on
        at least 9 of the first 10 gaps in all 9 runs, and the runs of zeros reached
        57–116 gaps. So 8 is twice Chrome's worst, and it is reached within Safari's
        first 10 gaps.
      - **Why no bound on a single `δT`.** A per-frame counter on a file faster than the
        display moves several frames per callback: up to 6 in Chrome on 120 fps, and
        about 4 per gap on a 240 fps file before any skip. That movement is what the
        check exists to see. A bound low enough to catch Safari's smallest jump (11)
        would sit close to it. And one Safari run showed no jump in its first 10 gaps.
    - **When it disagrees** (with at least 10 counted gaps): the estimate does not
      snap, estimation stops for this file, and step stays disabled. The readout says
      **"frame rate higher than this display can show; stepping not supported yet"**.
      The cap does not re-enable step for such a file. This is future work under OQ-2.
    - **If the browser lacks `getVideoPlaybackQuality`,** nothing snaps, and only the cap
      path ("frame rate uncertain") can enable step. Chrome, Safari and Firefox all
      have it (from memory).
    - **Phase 1 supports frame rates up to the display's refresh rate.** Files between
      1× and 2× that rate usually still snap correctly, but Phase 1 does not promise it.
  - **When it snaps.** The 60 vs 59.94 fps pair sets the bound for 60 fps content:
    `gap = 16.667 µs`, so with the margin it needs `ε ≤ 7.5 µs`.
    - With µs timestamps (`E = 1 µs`, `R = 1`) that holds from the first 10 gaps.
    - With whole-ms timestamps (`E = 1 ms`) it needs `N ≥ 134` frames, about
      **2.23 s** of playback, when `R = 1`. It needs `N ≥ 267`, about 4.45 s, when
      `R = 2`.
    - In general, the n vs n×1000/1001 pair is `d/1000` apart. So with `E = 1 ms` a
      snap needs at least about `2.22 s × R` of playback at any rate up to 240 fps; with
      `E = 10 ms`, `22.2 s × R`.
    - Measured on the whole-ms 60 fps fixture (author, round 7), recomputed with the
      margin: at `N = 134`, the worst `|d_est − 1/60|` over all start frames is 4.98 µs,
      against `ε` = 7.46 µs. The reviewer's in-browser snaps without the margin came at
      N = 120–121, about 2.02 s, in all 8 trials across Chrome and Safari.
  - **Drift bound, snapped.** `d` equals the rate's exact duration. The step target
    `(k + 0.5)·d` differs from the true middle of frame `k` only by the container's
    rounding of that frame's timestamp, at most `E/2` (0.5 ms for whole-ms files). That
    error does not grow with `k`, and it stays under the half-frame margin whenever
    `E < d`. There is no drift at any file length.
  - **Drift bound, not snapped** (step enabled at the cap, see below). `|d − true| ≤ ε`
    at the moment step is enabled. The target for frame `k` lands in frame `k` while
    `k·ε + E/2 < d/2`, that is, for `k < (d − E) / (2ε)`.
    - Example: a 12.5 fps file, which is not a candidate, at the 30 s cap. Its frame
      times are multiples of 10 ms, so `E = 10 ms`; `N` = 375 and `ε` = 26.7 µs. The
      bound holds for `k` < 1 312 frames, about 105 s. (The round-7 draft used a 300 fps
      example. That premise was false: on a 60 Hz display such a file now takes the
      cross-check's "not supported" path.)
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
    or at `ended`, whichever comes first, step is enabled with `d = d_est`. That
    requires at least 10 counted gaps and a cross-check that agrees; when it disagrees,
    the "not supported" message stays. The readout then shows the visible note "frame
    rate uncertain".
    - 30 s covers a snap with `E = 10 ms` and one run (22.2 s).
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
  (HTML spec, stated from memory, check). While `d` is unset, the `seeked` handler still
  clears `pending`; it skips only the setting of `k` (see "The `seeked` handler").
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
  - Otherwise the handler **always** sets `pending = false` (round 7, R7-B3). If `d` is
    known, it also sets `k` and `kTime` by rule 2 and sets `kValid = true`. If `d` is
    unknown, it skips only that step, and `kValid` stays false. Then it takes the head of
    `queue`, if there is one, and handles it as a fresh step press. While `d` is unknown,
    step is disabled, so the queue is empty.
- **Stale picture after a paused seek** (amended at the build by the user's decision,
  without a review round; the gate verifies it).
  - **The limitation.** Safari 26.6.2 sometimes keeps the old picture after a seek while
    paused. It re-presents the pre-seek frame, and no frame callback for the target
    follows. Measured over the C(b) sequence, 20 runs each:
    - stale in 10/20 as run, and in 12/20 with Safari frontmost and uncovered (visible,
      focused);
    - re-seeking to the target, or to target + d/4, healed 0 of 5;
    - `play()` then `pause()` healed 0 of 7.
    It is not fixable in Phase 1. **Chrome is fully supported in Phase 1**; Safari steps
    correctly, but its picture can be wrong after a paused seek.
    - **AMENDED 2026-09-29 (Phase 2, §2.11):** this limitation belongs to the system
      WebKit, not to Safari the app. The macOS desktop app uses the same
      `WebKit.framework` build as Safari 26.6.2 (Spike 1), so everything said here about
      Safari applies to it: the batched counter, the missing `webkitDecodedFrameCount`,
      and the stale picture. The browser-support wording in the README covers the app.
  - **Detection.** After a seek completes while paused and `d` is known, the target is
    the `k` set by the `seeked` handler. A frame callback **shows the target** when
    `round(mediaTime / d) = k`. The picture is the last presented frame, so the check
    uses the **latest** callback, from any registration generation. If it shows the
    target at `seeked`, the picture is right. Otherwise the player waits **250 ms** for
    a callback that does. If none comes, the readout shows **"Safari didn't update the
    picture: the frame shown may be wrong"** and sets `data-stale="true"`.
    - **AMENDED 2026-09-29 by Phase 2 (§2.11). This changes Phase 1's shipped text.** The
      wording names a browser, which is wrong in the desktop app. Phase 2 replaces it,
      in the web build and in the app, with one wording that does not name the host:
      **"The picture may not have updated after this seek. The frame number is
      correct."** The detection, the 250 ms wait and `data-stale` are unchanged.
    - Why the latest callback and not "callbacks since `seeking`": Chrome often presents
      the target, and fires its callback, before the `seeking` event is dispatched. A
      seek to the frame already shown fires no callback at all. The build's first
      version cleared its record at `seeking`, and it warned falsely on 17–19 of 41 B.3
      reads in Chrome.
  - `k` is unaffected. The warning clears at the next callback that shows the target.
    Playback (a `play` event) and a new file also clear it, since the picture is
    replaced then. A new seek replaces the target.
  - A check of the same form in the build's diagnostic (250 ms, a callback showing the
    target) was measured against the pixels. In two soaks of 20 runs it fired in exactly
    the stale runs, 5 and 7, and in no correct one.
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
"measuring frame rate…", "frame rate uncertain", or the "frame rate higher than this
display can show" message when they apply. The readout element
carries `data-frame`, `data-media-time`, `data-d-ms`, `data-d-snapped` and
`data-pending` (the player's `pending` flag) attributes, which the browser test reads.
It also carries `data-counter` (`unknown`, `per-frame` or `batched`, amended at the build)
and the estimate's `data-n`, `data-delta-t`, `data-runs`, `data-gaps` and `data-status`,
for the gate's measurements.

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

**Fixtures.** `scripts/make-fixture.sh` writes three files into `test/fixtures/`. The
generator is committed; the videos are git-ignored. Both files are 640×360 and made from
`testsrc`, encoded with `-c:v libx264 -pix_fmt yuv420p -r <rate>`. The default encode of
`testsrc` is yuv444p (High 4:4:4), which browsers do not decode.
(Amended at the build: the videos, 284 KB in all, are committed too; the `.mkv`
intermediate stays ignored.)

- **`frames.mp4`**: 30 fps, 3 s, 90 frames numbered 0–89, written straight to mp4. Its
  timestamps are exact; the time base is 1/15360.
- **`frames120.mp4`**: 120 fps, 2 s, 240 frames numbered 0–239, written straight to mp4
  with `-r 120`. Its timestamps are exact. Measured (author, round 7): ffprobe reports
  `time_base=1/15360`, `r_frame_rate=120/1`, `nb_frames=240` and duration 2.000 s. It
  is used by test (c). It has the same marks as the others, 9 cells.
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

Two marks are drawn on every frame of every file:

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

*(Updated 2026-09-29.)* Phase 2 is now a phase of this spec (§4), because its subject, how
a file reaches this player, is one this spec owns (§1, §2.2). Its design is §2.8–§2.12,
drafted from two spikes on branch `spike/vpa-tauri-webkit` (`SPIKE.md`). Phase 3 is
unchanged: the next extra feature (OQ-4), not yet chosen. Also still ahead, and not in
Phase 2: testing on Windows and Linux (OQ-6, OQ-7), signing and notarization, and
drag-and-drop in the desktop app.

### 2.8 The desktop app: shell and build (decision, recorded in `idea.md`, 2026-09-29)

- **One `src/`, a Tauri 2 shell.** The page is the web page. `src-tauri/` holds the
  shell, and `src/platform-tauri.ts` is the second implementation of `Platform` (§2.2).
  Nothing in `src/step.ts` changes for the desktop.
- **Which platform a build uses is decided at build time.** The desktop build runs
  `vite build --mode desktop --base=./ --outDir dist-desktop`. `src/main.ts` picks
  `tauriPlatform` when `import.meta.env.MODE === 'desktop'` and `webPlatform` otherwise,
  and imports the Tauri one dynamically. Vite replaces `MODE` with a constant, so the
  web bundle contains no Tauri code; the gate checks that (§4, Phase 2, D.4).
- **`--base=./`** because the app serves the page from `tauri://localhost/`, where the
  Pages base `/video-player-assimilator/` does not resolve (Spike 1, finding 3).
  `vite.config.ts` keeps the Pages base for the web build.
- **The window is made in `setup`**, from its config entry (`"create": false`). Only so
  the gate build can add its agent as a document-start script: in Spike 2,
  `append_invoke_initialization_script` ran after the `<video>` existed.
- **`<video crossorigin="anonymous">`** in `index.html`, for both builds. In the app the
  file comes from another origin (`stream:`), and without it the gate's pixel reads hit
  a tainted canvas. On the web the file is a same-origin `blob:` URL, where the attribute
  changes nothing; Phase 1's gate re-runs to confirm (§4, Phase 2, part W).
- **Builds.** `.github/workflows/desktop.yml` runs `tauri build` on `macos-latest`
  (arm64), `windows-latest` and `ubuntu-latest` on every push to `main`. On a pushed tag
  `v*` it also attaches the bundles, **unsigned**, to the GitHub Release for that tag:
  `.dmg` (macOS), `.msi` and NSIS `.exe` (Windows), `.deb`, `.rpm` and AppImage (Linux).
  No signing or notarization. Spike 1 built all three in CI (run 36603767160).
- **Tested on macOS only.** The Windows and Linux builds are built, not run. The README
  marks them **"unverified"**, and the release notes say the same. Linux users install
  their own GStreamer codecs (§1.1).
- *(Decided 2026-09-29 by the orchestrator.)* Accepted as drafted: no drag-and-drop in the app; a macOS build for arm64
  only (no Intel or universal build); the most recently opened file wins (§2.10); the
  release tag `v0.2.0` (§4, Phase 2, D.3); desktop facts in a new `rules/desktop.md`
  (Phase 2 close-out).
- **Drag-and-drop is not in the desktop app in Phase 2.** Tauri's window takes file drops
  itself, and a dropped path would be a third way to open a file, which the scheme's
  allow-list (§2.9) does not include. The app hides the page's "or drop a file here"
  hint. A later phase can add it.

### 2.9 The desktop file source: the `stream:` scheme (decision, recorded, Spike 2)

The file reaches `<video>` through a custom URI scheme, `stream:`, that the shell
registers with `register_asynchronous_uri_scheme_protocol` and answers from the file on
disk. The page builds the URL with Tauri's `convertFileSrc(path, 'stream')`:

- macOS and Linux: `stream://localhost/<encodeURIComponent(path)>`;
- Windows (WebView2): `http://stream.localhost/<encodeURIComponent(path)>`. The page there
  is `http://tauri.localhost`. (From the Tauri 2.12 sources, Spike 2. Untested.)

**The handler** (`src-tauri/src/stream.rs`), per request, on its own thread:

1. Decode the path. **If it is not a path the user opened, answer 403**, before touching
   the file. "Opened" means returned by the file dialog or delivered by a file-open event
   (§2.10), in this process. The comparison is after `std::fs::canonicalize` on both
   sides. An opened path that no longer exists answers 404.
2. `HEAD`: 200 with `Content-Length` and `Content-Type`.
3. **Single byte ranges only:** `bytes=a-b`, `bytes=a-` and `bytes=-n`, with the end
   clamped to the file. The answer is 206 with `Content-Range: bytes a-b/len`.
4. **At most 1 MiB (1 048 576 bytes) per answer.** A longer range is answered with its
   first 1 MiB, and `Content-Range` says so; the media stack asks again for the rest.
   The handler never reads more than it sends.
5. A malformed, unsatisfiable or multi-range header answers **416 with
   `Content-Range: bytes */len`**.
6. No `Range` header answers 206 with the first 1 MiB. **This is a deliberate departure
   from HTTP**, which says 200 with the whole file. The reason: WebKit's media stack always
   sends `Range`, so only a non-media request can arrive without one, and a full-file 200
   is exactly what this scheme exists to avoid. *(Decided 2026-09-29 by the orchestrator.)* The choice stays.
7. **Every answer carries CORS headers**, including 403, 404 and 416:
   `Access-Control-Allow-Origin: *` and `Access-Control-Expose-Headers: content-range,
   accept-ranges, content-length`. Without them the page sees an error answer only as
   "Load failed", and the gate cannot read pixels (§2.8).
8. `Content-Type: video/mp4` for `.mp4`, otherwise `application/octet-stream`.
9. **Every request gets an answer.** A panic in the handler is caught and answered with
   500. The spike's handler logged a panic and left the request unanswered, which would
   leave a seek waiting forever. The spike logged 0 panics, but its stuck seek is
   unexplained (OQ-8).

**Per-request log** in debug builds and in the gate build (§2.12), not in release: one
line per request to `stream.log` in the app's log directory, with the time, method,
`Range`, status, `Content-Range`, body bytes and handler time in µs, plus one line for
each caught panic. It is how OQ-8 gets its evidence.

#### Why not the asset protocol (decision, recorded)

Spike 2 measured Tauri's asset protocol (`asset:`, `convertFileSrc` with no scheme)
against this scheme in the production app. They **tied on every measurement**: 20/20
cold launches each, the same seek latency (median 12 vs 13 ms) and memory, 6/6 odd paths,
and "Open with" end to end. Spike 1's `asset:` failures were a harness bug (a Safari tab
took the session), not Tauri. `stream:` wins on what we control:

- it reads only what is asked, at most 1 MiB. The asset protocol answers a request with
  no `Range` by reading the whole file into memory;
- it answers a bad range with a 416 the page can see. The asset protocol's 416 has no
  CORS header, so the page sees "Load failed";
- it serves only files the user opened. The asset protocol needs an `assetProtocol`
  scope; the spike's was `**`, the whole disk, readable by any script in the page.

The cost is about 100 lines of Rust that this project owns and tests (§4, Phase 2,
part E). A blob URL was ruled out before the spikes: it holds the whole file in memory.

### 2.10 Opening a file in the desktop app (decision, recorded in `idea.md`)

Two ways, both through the shell, so the shell knows every path it may serve (§2.9):

- **The dialog.** In the app, "Open mp4…" does not open the page's `<input type="file">`.
  `tauriPlatform` cancels the input's click and invokes the command `pick_file`, which
  opens the system dialog from Rust (`tauri-plugin-dialog`, filter mp4), adds the path to
  the allow-list, and returns it.
- **"Open with" on macOS.** `tauri.conf.json` declares `bundle.fileAssociations` for mp4
  (role Viewer), which becomes `CFBundleDocumentTypes`; the app is then listed under
  Finder's "Open With". Finder sends an open-documents event, which Tauri delivers as
  `RunEvent::Opened`, for both a running app and a cold start (Spike 1, 4).
- **Windows and Linux: untested** (OQ-7). The path arrives in argv, which the shell reads
  at start. A second launch while the app runs would start a second process, so the shell
  uses `tauri-plugin-single-instance` on those two systems, and its callback hands the
  new argv's paths to the running app. Built in CI, never run.

**Paths are held until the page subscribes.** On a cold start, `RunEvent::Opened` arrives
about 87 ms after launch, before `setup`, so before the webview exists (Spike 1, 4).
`src-tauri/src/opened.rs` keeps one mutex over `{ subscribed, buffer }`:

- `deliver(paths)` (from `Opened`, argv, or the single-instance callback) adds each path
  to the allow-list. If the page has not subscribed, it appends them to `buffer`;
  otherwise it emits the event `opened` with them.
- The page first registers its `opened` listener, then invokes `subscribe_opened`, which
  sets `subscribed` and returns and empties `buffer`, under the same lock. So every path
  is delivered exactly once, whichever side comes first.
- The page loads the **last** path it receives: the most recent open wins. A new file
  resets the player as on the web (§2.3, "Reset on a new file").

Spike 2 measured the cold start with a stand-in that polled every 300 ms: `open -a` to
verified playback took 1.74–1.83 s, 10/10 across both candidates. The stand-in reloaded
the page to load the file, which the real platform does not.

**Double-click is not promised.** It works only when the app is the user's default for
mp4, and an app cannot make itself the default on macOS 26:
`LSSetDefaultRoleHandlerForContentType` returned 0 and changed nothing (Spike 1, 4). The
README explains how the user does it: Finder → an mp4 → Get Info → "Open with:" → the app
→ "Change All…". The Phase 2 gate checks double-click by hand after that (H.4).

### 2.11 One stale-picture wording, and browser support (decision, recorded in `idea.md`)

- **The warning** (§2.3, "Stale picture after a paused seek") reads, on the web and in the
  app: **"The picture may not have updated after this seek. The frame number is
  correct."** It names no browser. The old wording named Safari, which is wrong in the
  app. This changes Phase 1's shipped text (the note in §2.3). The web and the app keep
  one string, `MESSAGES.stale` in `src/main.ts`.
- **Browser support now covers the app.** Chrome: fully supported. Safari **and the macOS
  app**: step correctly, with Safari's limitations, because both use the same system
  WebKit (Spike 1: `WebKit.framework` 21624.5.1.11.3 in both). That is the stale picture
  after a long paused seek, and the batched counter (OQ-2's known limitation). Windows and
  Linux apps: unverified.
- **In the app, the stale picture is unmeasured.** Spike 1's "app" stale sets turned out
  to be Safari's. Spike 2's production gates had no stale read in 36 B/C(b) runs, which is
  too few long seeks to give a rate. The Phase 2 gate records the rate (G), and does not
  gate it. It does gate the warning being right.

### 2.12 The desktop gate harness (decision, recorded, Spikes 1–2)

`tauri-driver` has no macOS support, so there is no WebDriver for the app. The gate
drives the **production app** through an in-page agent, as Spike 2 did:

- **The gate build** is a release build with the Cargo feature `gate`, off by default:
  `tauri build --bundles app --features gate`. The feature adds exactly three things:
  `test/desktop/agent.js` as the window's document-start script; the per-request log
  (§2.9); and a command `gate_open(path)` that calls the same `deliver` as
  `RunEvent::Opened` (§2.10). The page, `src/` and the scheme handler are the release
  ones. CI builds without the feature.
- **The runner**, `test/desktop/run.ts`, is a plain HTTP channel on `127.0.0.1:5181`. It
  drives the unchanged `test/e2e/gate.ts` through a `Driver`, as Spike 1 did. Keys are
  synthetic `keydown` events on `window`; safaridriver sent real keys in Phase 1.
- **The runner asserts that it is talking to the app's page**, on every hello:
  `location.protocol === 'tauri:'` and `'__TAURI_INTERNALS__' in window`. A hello from
  any other page aborts the run. Spike 1 skipped this, and most of its "app" numbers were
  a leftover Safari tab's.
- **Conditions:** the runner runs under `caffeinate -dimu`, with the app window visible
  and focused. In Spike 1 the display slept, rAF stopped, the view presented at about
  10 fps, and the results were silently wrong.
- **A stuck seek** is a player-started seek whose `seeked` has not come 15 s after it
  started. The runner records it with the `stream.log` lines from its start to the
  timeout.

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
  steps by the estimate and shows the fixed note in §2.4.)* **Future work under this
  question:** files faster than the display presents, which Phase 1 refuses with "frame
  rate higher than this display can show; stepping not supported yet" (§2.3, round 7
  R7-B1). Stepping through such a file needs a frame source other than presented-frame
  callbacks. **Known limitation** (build, amended R7-B1): in a browser whose
  `totalVideoFrames` counter is batched (Safari 26.6.2 today), the cross-check is skipped,
  so a file faster than the display rate can snap to the wrong rate, for example 120 fps
  content presented at 60 snapping to 60.
- **OQ-3** — The Assimilator brand name and look for this player. *(needs-input)*
- **OQ-4** — Which extra feature comes after frame step: loop a section, speed control,
  or overlays? *(needs-input)*
- **OQ-5** — ~~Does "Open with" file association belong in the first desktop phase?
  *(needs-input)*~~ **RESOLVED 2026-09-29** (`idea.md`, "Agreed for Phase 2", and after
  Spike 1): **"Open with": yes**, in Phase 2, tested on macOS (§2.10). **Double-click:
  documented, not promised.** An app cannot make itself the mp4 default on macOS 26, so the
  README explains "Change All…", and the gate checks double-click by hand after it (H.4).
- **OQ-6** — Does Linux play media over a custom scheme? WebKitGTK plays `<video>` through
  GStreamer, and whether its source element accepts `stream://` at all is untested. It
  applies to the asset protocol too. *(needs-input: a real Linux machine with the
  GStreamer codecs.)* Blocks any claim that the Linux build works, not the Phase 2 gate:
  Phase 2 ships Linux marked "unverified" (§2.8). If it fails, the fallback is a design
  call for a later phase.
- **OQ-7** — Do file open and playback work on Windows and Linux? Untested in Phase 2:
  - Windows plays from `http://stream.localhost/…` in WebView2 (§2.9);
  - the path arrives in argv, and a running app receives it through the
    single-instance plugin (§2.10);
  - Linux file associations come from the bundle's `.desktop` entry, from memory,
    unchecked.
  *(needs-input: Windows and Linux machines.)* Blocks removing "unverified" from those
  builds, not Phase 2.
- **OQ-8** — Why did one seek never complete in Spike 2? Candidate B, gate set 1, A.4: a
  step's `seeked` never came within 15 s, and `pending` stayed stuck at frame 11. That is
  1 of 36 gate runs. It did not recur in the next 24, 12 of them with every request
  logged (0 errors, 0 panics). It could be the handler or WebKit. *(answerable by
  measurement.)* The Phase 2 gate runs enough repetitions to see it again at that rate
  (F), with every request logged (§2.9). **Blocks Phase 2's exit gate if it recurs**:
  then the build stops, and the user decides from the log.
  - *(Decided 2026-09-29 by the orchestrator.)* Any stuck seek fails F; that stays. If it recurs, the first option
    to weigh is a **watchdog** that re-issues a seek whose `seeked` has not come after a
    timeout. That would be a spec change, decided then, not now.

## 4. Implementation phases

Strictly sequential; each is one plan-mode pass.

### Phase 1 — Web player with frame-by-frame step
*Produces the observable: yes — a user picks an mp4 file in the browser, it plays, and they
step it frame by frame.*

- **Scope:** a Vite and TypeScript project with a single page: `index.html` and
  `src/main.ts` (the UI and key bindings). File input and drag-and-drop through the
  platform interface (§2.2): `src/platform.ts` and `src/platform-web.ts`, the browser
  implementation only. A `<video>` element with play, pause and seek. `src/step.ts`
  holds the frame-duration estimate (a pure, exported function), the snap and the
  frame-count cross-check, the enable rule and the cap, the reset on a new file, the
  step, and the no-callback case (§2.3). Vitest for the estimator unit test. Forward and back step by key and by button.
  The readout (§2.3) and the constant-rate note (§2.4). The generator for all three fixtures and
  both browser runs (§2.6). `vite.config.ts` with the Pages `base`, and the Pages workflow
  (§2.5).
- **Exit gate:** in both Chrome and Safari (§2.6), a browser test runs parts A and B,
  and the tests in part C.

  **A. `frames.mp4`** (30 fps, frames 0–89, exact timestamps):
  1. Load the file. Assert step is disabled.
  2. Play for at least 1 s. Assert that `d` has snapped to exactly `1/30`
     (`data-d-snapped` is true, and `data-d-ms` is 33.333…).
  3. Pause. Seek to `10.5/30` s and wait for `seeked`. Read frame 10 from the pixels.
  4. Press `.` 5 times; read frame 15. Press `,` 7 times; read frame 8.
  5. Seek to `0.5/30` s. Press `,` once; read frame 0 (clamped).

  **B. `frames60ms.mp4`** (60 fps, frames 0–299, whole-ms timestamps):
  1. Load the file. Play for 1 s. Assert step is **still disabled** and the readout
     says "measuring frame rate…". At about 60 frames, `ε` ≈ 16.7 µs, which is above
     the 7.5 µs bound.
  2. Keep playing, to at least 3 s in total. Assert `d` has snapped to exactly `1/60`.
     The snap needs 134 frames, about 2.23 s.
  3. Pause. Seek to `10.5/60` s. Press `.` 40 times, reading the pixels after **every**
     press: frames 11, 12, … 50.
  4. Seek to `250.5/60` s. Press `,` 40 times, reading after every press: frames 249 …
     210. With the round-6 `d_m` = 16 ms, every one of these reads would be wrong.
  5. Seek to `299.5/60` s. Press `.` once; read frame 299 (clamped at `last`).

  **C. Tests for the round-7 fixes.** The author applied these without a round 8, so
  the build verifies them:
  - **(a) An early skipped frame does not cause a wrong snap** (R7-B2). This is a unit
    test of the estimator, which `src/step.ts` exports as a pure function over a stream
    of `(mediaTime, totalVideoFrames, runId)` samples, run with Vitest. The synthetic
    streams are:
    - 30 fps with µs-rounded `mediaTime` and 60 fps with whole-ms `mediaTime`;
    - each with its **first** gap doubled (one callback removed);
    - and separately with a 7-frame skip at gap 3, as measured in round 5.

    Assert: never a snap to 15 or 30 fps, and the estimate snaps to exactly 30 or 60
    fps. Also assert that before 10 counted gaps nothing snaps, and that recounting
    after `d_min` drops changes `N` as specified.
  - **(b) A seek-bar drag before `d` is known, then steps work** (R7-B3). In Chrome and
    Safari with `frames60ms.mp4`:
    - Play. At about 0.5 s, drag the player's own seek bar to 0 s: set its range input
      and dispatch `input`, so the player sets `currentTime` and `pending`.
    - Assert `data-pending` returns to false after that seek's `seeked`, although `d`
      is still unknown.
    - Keep playing until `d` snaps to exactly `1/60`. With `R = 2` that needs 267
      frames, about 4.45 s of counted playback, so it snaps before the clip ends.
    - Pause, seek to `100.5/60`, press `.` 3 times, and read frames 101, 102, 103.
  - **(c) 120 fps on a 60 Hz display: no wrong snap** (R7-B1). With `frames120.mp4`,
    the test first measures the display rate from `requestAnimationFrame` intervals.
    Then it plays the whole clip. Allowed outcomes:
    - step is disabled, and the readout shows "frame rate higher than this display can
      show; stepping not supported yet"; or
    - `d` is exactly `1/120`, and 10 steps from frame 100 read 101…110 from the pixels.

    Any other snapped `d` fails. On a ~60 Hz display the **Chrome** run must take the
    first outcome, because round 7 measured Chrome presenting 120 fps content at 60.
    Safari presented all 120 in round 7, so it is expected to take the second.
    **CORRECTED 2026-09-29 (Spike 1, finding 7):** Safari does **not** present all 120.
    On a 60 Hz display it presents about 60 frames per second: 96–118 frame callbacks
    over the 2 s clip in Safari 26.6.2, and 106–119 in the Tauri app on the same WebKit. It
    still snapped exactly `1/120` in every run (Phase 1's 3 gate runs, and the spikes'
    3/3, 7/7 and 18/18). That is because 96–119 callbacks is between 1× and 2× the
    display rate, so some gaps are single frames and `d_min` stays right (§2.3, "Why it
    is needed"). The expected outcome is unchanged, but the reason given was wrong.
    **Amended at the build:** in a browser whose counter is batched (the readout's
    `data-counter`), the test records the outcome, the snapped `d` or the refusal, and
    asserts neither (OQ-2's known limitation). Chrome, whose counter is per-frame, keeps
    the full assertion.

  "Read" means the pixel bit-strip decode (§2.6). The test sends one key and waits for
  the readout's `data-frame` to hold the expected index and for no seek to be pending.
  Then it waits on its own side for a `requestVideoFrameCallback` that shows the target
  frame, `round(mediaTime · fps) = k`, and ignores callbacks for any other frame. If none
  comes within 1 s (the clamp case, where the frame on screen does not change), it goes
  on. Then it reads the pixels. (Amended at the build by the user's decision: it used to
  wait for any one callback, or 100 ms. A callback registered before a seek can fire
  after it for the old frame, which released the read too early.)

  **Stale picture, Safari only** (amended at the build by the user's decision). In the
  Safari run, B.3 and C(b) accept a read whose pixels are wrong if the readout has
  `data-stale="true"` (§2.3, "Stale picture after a paused seek"). Every other read, and
  every read in the Chrome run, must show the right frame. In the Chrome run no read may
  have `data-stale="true"`: a warning there is itself a failure. The Chrome run then repeats A.1–A.4
  against the deployed Pages URL, which proves the deploy serves the working player and
  not just a page.
- **Manual one-time setup** (not code): install `ffmpeg-full`; enable Pages with source
  "GitHub Actions"; run `safaridriver --enable` and turn on "Allow Remote Automation".
- **Close-out:** seed `rules/player.md` (the stack, the platform layer, the step
  algorithm). Commit the test file generator and the three videos, which total 284 KB
  (amended at the build by the user's decision; they were to be git-ignored). Write
  `shipped` after the gate passes.

### Phase 2 — Desktop app
*Produces the observable: yes — a user on macOS opens an mp4 in the desktop app, through
"Open mp4…" or Finder's "Open With", it plays, and they step it one frame at a time. The
frame and the step are Phase 1's. What is new is how the file arrives, which is the
platform layer that §1 names as "not something anyone watches". It is argued for here
because it is the only way the desktop user reaches the observable at all: without it the
app is an empty window.*

Drafted 2026-09-29 from `idea.md` ("Agreed for Phase 2") and two spikes on branch
`spike/vpa-tauri-webkit` (`SPIKE.md`, evidence in `spike/results/`). Design: §2.8–§2.12.

- **Scope:**
  - `src-tauri/`:
    - `Cargo.toml`: `tauri` 2, `tauri-plugin-dialog`, `percent-encoding`, and
      `tauri-plugin-single-instance` for Windows and Linux only. The feature `gate`.
    - `tauri.conf.json`: identifier `com.ivapo.video-player-assimilator`; the version
      from `package.json`; one window, 960×760, `"create": false`;
      `frontendDist: ../dist-desktop`; `beforeBuildCommand: npm run build:desktop`;
      `fileAssociations` for mp4 (role Viewer); bundle targets `all`. `csp` stays `null`,
      as in the spikes; a CSP is not in scope. The product name and icon are
      placeholders until OQ-3. *(Decided 2026-09-29 by the orchestrator.)* The identifier
      `com.ivapo.video-player-assimilator` **stays even if the brand changes** (OQ-3):
      macOS keys the app's file associations, data and log directories to it, so
      renaming it later would orphan them. Only the product name and icon follow the
      brand.
    - `capabilities/default.json`: what the page needs to `listen` for `opened`.
    - `src/main.rs`: the builder, the window made in `setup`, `RunEvent::Opened`, argv
      at start, and the single-instance callback.
    - `src/stream.rs`: the handler, `parse_range`, and the allow-list (§2.9).
    - `src/opened.rs`: `deliver`, `subscribe_opened` and `pick_file` (§2.10).
    - `src/gate.rs`: the `gate` feature only (§2.12).
    - Rust unit tests, run by `cargo test`, for `parse_range`, the allow-list, and the
      exactly-once delivery in both orders.
  - `src/platform-tauri.ts`: `tauriPlatform(input)`, implementing `Platform` (§2.2).
  - `src/main.ts`: the platform chosen by `import.meta.env.MODE` (§2.8); the new
    `MESSAGES.stale` (§2.11); the drop hint hidden in the app.
  - `index.html`: `crossorigin="anonymous"` on the `<video>`.
  - `package.json`: `build:desktop` (`tsc --noEmit && vite build --mode desktop
    --base=./ --outDir dist-desktop`) and `tauri` scripts; `@tauri-apps/api`; and
    `@tauri-apps/cli` pinned to 2.12.x, which Spike 1's CI used.
  - `.github/workflows/desktop.yml` (§2.8).
  - `test/desktop/`: `agent.js`, `run.ts`, and the suites below (launches, scheme probe,
    paths, large file, stale soak, "Open with").
  - `scripts/make-big-fixture.sh`: writes the 1 GB file of part E outside the repo:
    `testsrc2` at 1920×1080, 30 fps, 640 s, `h264_videotoolbox` at 40 Mb/s, yuv420p, and
    no `faststart`, so `moov` comes after `mdat`. That is the shape of Spike 2's file,
    1 093 112 387 bytes.
- **Exit gate.** All on this Mac (macOS 26.6.2, arm64, ~60 Hz display), on the gate build
  of §2.12 unless a step says otherwise. Every step in the app runs under
  `caffeinate -dimu` and asserts the app's page (§2.12).

  **D. Builds**
  1. `npm ci`, `npm run build`, `npm test` (at least the 38 Vitest tests of Phase 1) and
     `cargo test` pass.
  2. `desktop.yml` passes on all three runners for the merge commit.
  3. For the tag `v0.2.0` on `main`, the GitHub Release holds six unsigned bundles:
     `.dmg`, `.msi`, NSIS `.exe`, `.deb`, `.rpm` and AppImage.
  4. The web bundle contains no Tauri code: `dist/` has no `__TAURI` and no `stream.`.
     The release app has no `gate_open`: invoking it fails.

  **E. The `stream:` scheme**
  1. **Launches:** 20 cold launches, each loading `frames.mp4` through `gate_open`. The
     file loads 20/20. Recorded: first presented frame after `src` is set.
  2. **Probe,** by `fetch()` from the app's page against `frames.mp4` (all asserted):
     `bytes=a-b`, `bytes=a-` and `bytes=-n` give 206 with the right bytes and
     `Content-Range`; a range over 1 MiB gives exactly its first 1 048 576 bytes; a bad,
     out-of-range or multi-range header gives 416 with `bytes */len`; `HEAD` gives 200
     with the length; no `Range` gives 206 of the first 1 MiB; a path never opened gives
     **403**, and an opened path deleted afterwards gives 404. Every answer, 403, 404
     and 416 included, carries `Access-Control-Allow-Origin`, so the page sees each
     status rather than "Load failed".
  3. **Paths:** the six names of Spike 2 (spaces; `&`; NFC and NFD accents;
     Cyrillic, CJK and emoji; `%20#?`; a 250-byte name), all in a directory whose name
     has spaces and Unicode. Each loads, and after a seek to `10.5/30` the pixels read
     frame 10.
  4. **The 1 GB file:** loads, and 50 random paused seeks each present a frame within
     2 s (50/50). The app process's peak RSS stays under 300 MB, which shows that the
     handler does not hold the file. Recorded: first frame; seek to `seeked`; seek to
     the target frame; peak RSS of the app and WebContent processes.
  5. **The log:** `stream.log` has one line per request of E.1–E.4, and no panic line.

  **F. Phase 1's gates in the app.** Parts A, B, C(b) and C(c) of Phase 1, unchanged in
  `test/e2e/gate.ts`, with each file loaded through `gate_open`. **27 repetitions,
  that is, 108 gate runs.**
  - *Why 27:* OQ-8's stuck seek came in 1 of 36 gate runs. If it still happens at that
    rate, 108 runs miss it with probability (35/36)^108 = 4.8%. So the gate sees it with
    95% confidence, and a clean result bounds its rate below 1/36 at that confidence.
    The spike ran 12 gate runs in about 95 s, so this takes about 15 minutes.
  - **Stale reads are gated on correctness, in every part:** a read may show the wrong
    frame only when the readout has `data-stale="true"`, and `data-stale="true"` with the
    right frame fails. That extends Phase 1's Safari rule, which accepted flagged reads
    only in B.3 and C(b), to A, because A.3's seek is also a long paused seek, and 108
    runs make a stale A.3 likely if the app is stale as often as Safari. When the warning
    shows, the readout's text is the §2.11 wording.
  - **Any stuck seek fails the gate** (§2.12; kept by the orchestrator's decision,
    2026-09-29, see OQ-8). The build then stops, with the stuck
    seek's `stream.log` lines, for the user's decision (OQ-8).
  - C(c) records its outcome, as Phase 1 amended for a batched counter, and asserts that
    `data-counter` is `batched`.

  **G. Stale soak (the rate is recorded; the warning is gated).** Spike 1's 3a sequence
  in the app: `frames60ms.mp4`, play until `d` snaps, pause, seek to `100.5/60`, read the
  pixels at 300 ms and at 2 s. Two sets of 50.
  - Gated: the warning is exact. It fires in every run whose picture is stale at 300 ms,
    and in no run whose picture is right.
  - Recorded: the stale rate per set, how many heal by 2 s, and the time from `seeked`
    to the target's callback in the runs that are not stale.

  **H. File open** (the release app, not the gate build, registered with `lsregister -f`)
  1. **"Open with", cold**, driven by `open -a <app> <file>`, which sends Finder's
     open-documents event: 5 runs. The app starts, and `frames60ms.mp4` plays and snaps.
     Recorded: `open` to the first presented frame.
  2. **"Open with", running**, with `frames.mp4` already loaded: 5 runs. The same process
     loads `frames60ms.mp4`, the player resets, and it snaps. No second process.
  3. **The dialog, by hand:** "Open mp4…" shows the system dialog filtered to mp4. The
     picked file plays, and `.` steps it.
  4. **Double-click, by hand:** follow the README's "Change All…", then double-click an
     mp4 in Finder with the app closed, and again with it running. It plays both times.
     Afterwards, restore the tester's own default mp4 player.
  5. **First launch of the downloaded release, by hand:** download the `.dmg` from the
     `v0.2.0` release, install, and open. Gatekeeper blocks it; the README's steps get
     past that, and a file then opens and steps.

  **W. The web build still works.** `src/` and `index.html` changed, so Phase 1's gate
  runs once, unchanged, in Chrome and in Safari (§2.6), with Phase 1's pass rules: no
  `data-stale="true"` anywhere in Chrome, and the new wording when it shows in Safari.
  After the merge, the Chrome run repeats A.1–A.4 against the deployed Pages URL.

  **Not in the gate:** Windows and Linux, which are built (D.2) and not run (OQ-6,
  OQ-7). Drag-and-drop in the app, which Phase 2 does not have (§2.8).

- **Predictions** (written 2026-09-29, before any Phase 2 measurement; not to be edited
  after it). The basis is the spikes' measurements on this Mac.

  | step | prediction | basis |
  |---|---|---|
  | D.2 CI | 3/3 pass | Spike 1 CI: 3/3 in 237–384 s |
  | D.3 bundle sizes | `.dmg` 2.8–3.6 MB; `.msi` 2.9–3.8 MB; NSIS 1.9–2.6 MB; `.deb`/`.rpm` 3.0–3.9 MB; AppImage 80–90 MB | Spike 1: 2.79, 2.90, 1.93, 2.98, 2.98 and 81.6 MB, plus two plugins |
  | E.1 launches | 20/20; first frame median 100–150 ms, max under 250 ms | Spike 2, B: 20/20; median 113 ms (95–195) |
  | E.2 probe | all as specified; the 403 is new code and has no spike number | Spike 2, B's range table |
  | E.3 paths | 6/6, frame 10 | Spike 2: 6/6 for both candidates |
  | E.4 1 GB: first frame | 120–200 ms | Spike 2, B: metadata 102 ms, first frame 143 ms |
  | E.4 seek → `seeked` | median 10–20 ms, p95 under 40 ms | Spike 2, B: median 13, p95 24, max 46 ms |
  | E.4 seek → frame shown | median 12–25 ms, p95 under 50 ms; 50/50 | Spike 2, B: median 16, p95 33 ms; 50/50 |
  | E.4 peak RSS | app 90–120 MB; WebContent about 40 MB | Spike 2, B: app 99, WebContent 40 |
  | E.5 handler time | median about 50 µs, p99 under 250 µs | Spike 2, B's log: median 54 µs, p99 195 µs |
  | F: A, B, C(b) | pass in every run that has no stuck seek | Spike 2: 71/72 gate runs over both candidates; the miss was the stuck seek |
  | F: stuck seeks | **1–4 in 108: I expect it to recur, so F is likely to stop the build** | B's rate in Spike 2 was 1/36: 3.0 expected in 108, P(at least one) = 95%. If it is WebKit's and not the handler's, the rate over both candidates is 1/72: 1.5 expected, P = 78% |
  | F: stale reads | 0–5 in 108 runs, all flagged; no flag on a right frame | Spike 2: 0 stale in 36 B/C(b) runs; the warning exact in 25/25 across both spikes |
  | F: C(c) | `batched` 27/27; `d` = 1/120 exactly 27/27; 96–119 callbacks per 2 s clip | Spike 2: `batched` and 1/120 in 18/18; Spike 1: 106–119 (app), 96–118 (Safari) |
  | G: stale rate | **3–12% per set of 50**: lower than Safari, not zero | Safari, same procedure: 12/96 (Spike 1, corrected); app gates: 0/36 (Spike 2); Phase 1 under safaridriver: 10–12/20, not comparable |
  | G: warning | exact in 100/100 | 25/25 stale runs warned, 0/219 correct runs |
  | G: healed by 2 s | none | 0 of 25 healed in Spike 1; none in Phase 1 |
  | G: `seeked` → target callback, not stale | median 9–11 ms, max about 20 ms | Spike 1: median 9–11, max 19 ms |
  | H.1 cold "Open with" | 5/5; `open` to the first frame 1.4–1.8 s | Spike 2: 10/10, 1.74–1.83 s to verified playback, including a page reload the real platform does not do |
  | H.2 running "Open with" | 5/5; under 0.5 s to the first frame | Spike 1: `Opened` reaches the running process; first frame about 113 ms after `src` |
  | H.3 dialog | works | not measured by the spikes |
  | H.4 double-click | works, cold and running, after "Change All…" | Spike 1's prediction; not established, because the spike could not make the app the default |
  | H.5 Gatekeeper | the first open is blocked; "Open Anyway" in System Settings → Privacy & Security gets past it | from memory of macOS 15 and later; not measured |
  | W | Phase 1's gate passes in both browsers; Safari shows the new wording when stale | only a string, an attribute and the platform choice changed on the web |

- **Manual one-time setup** (not code): install the Rust toolchain and
  `@tauri-apps/cli` (Command Line Tools suffice; no full Xcode, Spike 1); `ffmpeg-full`
  for the 1 GB file; register the app with `lsregister -f` for H. The web gate needs
  Phase 1's setup (safaridriver, Pages).
- **Order at the end:** F, G and H.1–H.4 run on this branch's builds. Then merge, push the
  tag `v0.2.0` on `main`, and run D.2–D.3, H.5 and W's Pages check against what CI
  published.
- **Close-out** (the reconciliation step):
  - `rules/player.md`: the stale wording; the platform layer (the Tauri implementation is
    built); browser behaviour with the macOS app beside Safari, and 120 fps presenting at
    about 60; add `src/platform-tauri.ts` to `sources`.
  - A new `rules/desktop.md`: the shell, the scheme, file open, the builds and the gate
    harness. Sources `src-tauri/src/*.rs`, `src-tauri/tauri.conf.json`,
    `.github/workflows/desktop.yml` and `test/desktop/*`. It is a new rule, not more
    lines in `rules/player.md`, which has 90 as its cap.
  - `README.md`: a desktop section, with the Releases link; that the builds are
    unsigned and how to open them (Gatekeeper, SmartScreen); **Windows and Linux
    "unverified"**; Linux needs its GStreamer codecs; "Open with", and "Change All…" for
    double-click. Browser support in the §2.11 wording, and the new warning text.
  - `CLAUDE.md` stanza: none needed; it already describes a web build and a desktop app
    from one `src/`.
  - Record G's stale rate and OQ-8's result in the review record, against the
    predictions above.
  - Write Phase 2's `shipped` date after the gate passes.

<!--
The review record is a sibling file, not a section: it lives at
specs/reviews/<id>.md, append-only, one heading per round. See §7.
-->
