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
  something anyone watches. Phase 2 of the roadmap (§2.6) touches it and must say so.

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

### 2.3 Frame-by-frame step

A `<video>` tag has no "next frame" call and does not expose the frame rate. Two parts:

- **Frame duration.** Read it from `requestVideoFrameCallback`: while the video plays, the
  callback reports `mediaTime` for each presented frame, and the gap between two is one
  frame. The player takes the smallest stable gap over the first frames. Where the
  callback is missing, the user types the frame rate (OQ-1).
- **The step.** Pause, then set `currentTime` to the current frame time plus or minus one
  frame duration. The target is aimed at the middle of the frame (a half-frame offset), so
  a rounding error cannot land on the neighbor.

Keys: `.` and right arrow step forward, `,` and left arrow step back, space plays and
pauses. Buttons do the same.

### 2.4 Files with a variable frame rate

For a variable-rate video, one fixed frame duration is wrong. Phase 1 states this in the
interface and steps by the estimated duration. It does not try to be exact (OQ-2).

### 2.5 Hosting

`vite build` writes static files. They deploy to GitHub Pages. No headers or server
settings are needed, because there is no `SharedArrayBuffer` and no wasm.

### 2.6 Roadmap after Phase 1

Phase 2 wraps the same `src/` in Tauri and adds the file-open path. Phase 3 is the next
extra feature (OQ-4). Each is a phase in this spec or a new spec; §6.1's ordered test
decides which.

## 3. Open questions

- **OQ-1** — When `requestVideoFrameCallback` is missing, is a typed frame rate enough, or
  do we refuse to step? It is in current Chrome, Safari and Firefox; the review checks the
  minimum versions. *(design call)*
- **OQ-2** — For variable-frame-rate files, do we step by the estimated duration, or walk
  the callback times (step by seeking, then read the next presented `mediaTime`)? *(design
  call, deferred by evidence: measure on a real file first)*
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

- **Scope:** a Vite and TypeScript project with a single page. File input and drag-and-drop.
  A `<video>` element with play, pause and seek. Frame-duration estimate (§2.3), forward
  and back step by key and by button, and a readout of the current frame time. The platform
  layer exists as an interface with the browser implementation only. Static build and a
  GitHub Pages deploy.
- **Exit gate:** with a 30 fps, 3 s test file that has its frame number drawn on every
  frame (made by `ffmpeg` with `testsrc` and `drawtext`, so the number is checkable by
  eye and by script), a browser test does this: load the file, pause on frame 10, step
  forward 5 times and read frame 15 on screen; step back 7 times and read frame 8. The
  same test passes in Chrome and in Safari. The built site loads at its GitHub Pages URL.
- **Close-out:** seed `rules/player.md` (the stack, the platform layer, the step
  algorithm). Commit the test file generator, not the video. Write `shipped` after the gate
  passes.

<!--
The review record is a sibling file, not a section: it lives at
specs/reviews/<id>.md, append-only, one heading per round. See §7.
-->
