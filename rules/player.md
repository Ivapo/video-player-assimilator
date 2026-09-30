---
title: player
sources:
  - src/step.ts
  - src/main.ts
  - src/platform.ts
  - src/platform-web.ts
  - src/platform-tauri.ts
  - index.html
  - vite.config.ts
  - scripts/make-fixture.sh
  - test/e2e/gate.ts
  - .github/workflows/pages.yml
covers: >
  The web player as built: stack, platform layer, frame-duration estimate, step, stale-picture
  detection, fixtures, the gate, the deploy, and what each browser does
max_lines: 90
generated: 2026-09-29
---

# Player

**What is true right now.** Why each rule looks the way it does is in `specs/player_spec.md`
(vpa-001, §2.3) and `specs/reviews/vpa-001.md`.

## Stack and layout
- Vite and TypeScript, no framework. One page: `index.html`, wired by `src/main.ts`. Playback is
  the `<video>` tag; the file stays on the device.
- `vite.config.ts` sets `base: '/video-player-assimilator/'`. `.github/workflows/pages.yml`
  runs the unit tests, builds and deploys to Pages on push to `main`.
- Platform layer: `src/platform.ts:Platform` (`onFile`). `src/platform-web.ts:webPlatform` is the
  file input plus drag-and-drop, as object URLs, revoking the previous one. In a dev build only,
  `?src=<url>` loads a file once (the Safari gate needs it). `src/platform-tauri.ts:tauriPlatform`
  is the desktop one (`stream:` URLs, the dialog, "Open with"; see `rules/desktop.md`).
  `src/main.ts` picks by `import.meta.env.MODE === 'desktop'`, so the web bundle has no Tauri.
- `<video crossorigin="anonymous">`: in the app the file is cross-origin, and the gate reads pixels.

## Frame duration — `src/step.ts:Estimator`
- Fed by `requestVideoFrameCallback` while playing. `StepController` re-registers at `seeked`
  and on a new file, with a generation number; an old registration's callback feeds only the
  stale check, never the estimate.
- Runs end at pause, seek and `ended`. A run's first callback only starts it; the second anchors.
- Gaps under `MIN_GAP` (1/240 s − 1 ms) are ignored. `d_min` is the smallest gap; every stored
  gap is recounted when it drops. A gap over 7 × `d_min` is not counted and splits its run, so
  `R` counts segments and `ΔT` sums only counted gaps.
- `E` is the coarsest of 100/10/1 ms that every counted time sits on, else 1 µs. `ε = R·E/N`.
- Snap: ≥ 10 counted gaps, `ε ≤ 0.9·gap(c)/2`, `|S/N − c| ≤ ε`, c among n and n·1000/1001 fps,
  n = 1…240. Then `d` is exact and estimation stops.
- Counter cross-check `|ΔT − N| ≤ 0.1·N + 3·R`: applied only once `totalVideoFrames` is seen
  per-frame (8 advancing gaps in a run). Batched (8 flat) skips it; until either, nothing is
  decided. Disagreement is final: "frame rate higher than this display can show…".
- Cap: 30 s of counted playback, or `ended`: step enabled with `d = S/N`, "frame rate uncertain".

## Step — `src/step.ts:StepController`
- State: `k`, `kTime`, `kValid`, `pending`, `ownPaused`, FIFO `queue`. Own pause snaps to
  mid-frame; `seeked` sets `k = floor(t/d + 0.001)` clamped to `last = round(duration/d) − 1`.
  A step while pending queues; with `kValid` false it snaps first and re-queues at the head.
- Keys: `.`/→ forward, `,`/← back, space play/pause. Step is disabled until `d` is known.

## Stale picture — `StepController.watchForTarget`
- After a paused seek, the latest frame callback (any registration) must show `k`,
  `round(mediaTime/d) = k`, at `seeked` or within `STALE_MS` (250 ms). Otherwise the readout
  says `MESSAGES.stale`, "The picture may not have updated after this seek. The frame number is
  correct." (web and app), and `data-stale` is true. `k` is unaffected; the flag clears when the
  target shows, on `play`, or on a new file.
- Needs `d`: a stale picture after a seek made before `d` is known is not detected (known
  limitation, OQ-2).

## Readout attributes
`data-frame`, `data-media-time`, `data-d-ms`, `data-d-snapped`, `data-pending`, `data-stale`,
and for measurement `data-status`, `data-n`, `data-gaps`, `data-runs`, `data-delta-t`,
`data-quantum`, `data-counter`, `data-d-min`.

## Fixtures and gate
- `scripts/make-fixture.sh` (ffmpeg-full) writes `frames.mp4` (30 fps), `frames120.mp4`
  (120 fps) and `frames60ms.mp4` (60 fps, whole-ms) with a 9-bit strip, and checks them with
  ffprobe. The three mp4s are committed (284 KB).
- `npm test`: Vitest, C(a). `npm run test:chrome`: Playwright, installed Chrome, headed, on
  the production build. `npm run test:safari`: Safari.app through safaridriver, on `vite dev`.
  The desktop runner (`rules/desktop.md`) is the third. All share `test/e2e/gate.ts`; a read
  waits for a callback showing the target frame, and a flagged read must carry the warning.

## Browser behaviour (measured 2026-09-28/29, Chrome and Safari 26.6.2, 60 Hz display)
- Chrome: fully supported. Counter per-frame; 120 fps content is refused.
- Safari and the macOS app (the same system WebKit): counter batched, so the cross-check is
  skipped; no `webkitDecodedFrameCount`. 120 fps presents at about 60 (96–119 callbacks per 2 s)
  and still snapped to 1/120 in every gate run. After a long paused seek the picture can stay
  stale (Safari: 10–12 of 20 soak runs under safaridriver); re-seek, nudge and play/pause fix
  none. Detected and warned once `d` is known. The gate's `'app'` read rule requires the flag
  to be exact.
- Time to snap: 30 fps ≈ 0.33–0.44 s (N = 10); whole-ms 60 fps ≈ 2.22–2.30 s (N = 134); with
  a second run (C(b)) ≈ 4.5 s (N = 267).
