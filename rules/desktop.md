---
title: desktop
sources:
  - src-tauri/src/main.rs
  - src-tauri/src/stream.rs
  - src-tauri/src/opened.rs
  - src-tauri/src/gate.rs
  - src-tauri/tauri.conf.json
  - src-tauri/Cargo.toml
  - src/platform-tauri.ts
  - .github/workflows/desktop.yml
  - test/desktop/agent.js
  - test/desktop/run.ts
  - test/desktop/channel.ts
  - scripts/make-big-fixture.sh
covers: >
  The desktop app as built: the Tauri shell and its two builds, the stream: scheme, file
  open (dialog, "Open with", the buffer), CI and releases, and the desktop gate harness
max_lines: 80
generated: 2026-09-29
---

# Desktop

**What is true right now.** Why is in `specs/player_spec.md` (vpa-001, §2.8–§2.12).

## Shell and builds
- Tauri 2 (`tauri ~2.12`; `@tauri-apps/api` and CLI 2.12.0, kept on one minor). The page is
  the web page: `npm run build:desktop` is `vite build --mode desktop --base=./ --outDir
  dist-desktop`, and `src/main.ts` loads `src/platform-tauri.ts:tauriPlatform` only when
  `MODE === 'desktop'`. The web bundle holds no Tauri code.
- `tauri.conf.json`: identifier `com.ivapo.video-player-assimilator` (keep it if the brand
  changes: file associations and data dirs key on it), version from `package.json`, one window
  960×760 with `create: false`, made in `setup`, mp4 `fileAssociations` (Viewer), `csp: null`.
  The product name and icon are placeholders (OQ-3).
- Release: `npm run tauri -- build` → `src-tauri/target/`. Gate: `npm run tauri:gate`
  (feature `gate`) → `src-tauri/target-gate/`, the same `.app` name and bundle id, so only one
  of the two is registered with LaunchServices at a time.
- The `gate` feature adds exactly: `test/desktop/agent.js` as a document-start script,
  `gate.rs:gate_open`, and the request log. The release executable has no `gate_open` string.
- No drag-and-drop in the app; `#name` starts as "no file open".

## `stream:` — `src-tauri/src/stream.rs`
- URL: `convertFileSrc(path, 'stream')`: `stream://localhost/<encoded path>` (macOS, Linux),
  `http://stream.localhost/…` (Windows, untested).
- `AllowList`: only paths the user opened, stored as delivered and canonical; a request matches
  either, or its own canonical form. No match → 403 before the file is touched; an opened file
  now gone → 404.
- `respond`: HEAD 200 with length; single ranges (`a-b`, `a-`, `-n`) → 206, at most `CHUNK`
  (1 MiB); no Range → 206 of the first MiB (deliberate, not HTTP's 200); malformed, multi or
  out-of-range → 416 `bytes */len`. CORS allow-origin and expose headers on every answer.
- `handle` runs each request on its own thread; a panic answers 500. `stream::log` writes
  `~/Library/Logs/com.ivapo.video-player-assimilator/stream.log` (epoch ms, method, range,
  status, content-range, bytes, µs, path) in debug and gate builds only.

## File open — `src-tauri/src/opened.rs`
- `pick_file` (async): the dialog, filtered to mp4, allows the path and returns it. The page
  cancels its file input's click and calls this instead.
- `deliver` (from `RunEvent::Opened` on macOS, argv at start, the single-instance callback on
  Windows and Linux, `gate_open`): allows the paths, then under one lock emits `opened` or
  buffers. `subscribe_opened` sets subscribed and returns the buffer. `on_page_load` Started
  clears subscribed, so a reloading page gets paths from the buffer. The page listens first,
  then subscribes, and loads the last path it receives.

## CI and releases — `.github/workflows/desktop.yml`
- `tauri build` on macos-latest (arm64), windows-latest and ubuntu-latest, on push to `main`
  and to `spec/vpa-001-p2`. On a `v*` tag: `gh release create`, then each build attaches its
  bundles unsigned: `.dmg`, `.msi`, NSIS `.exe`, `.deb`, `.rpm`, AppImage.
- Only macOS is tested. Windows and Linux are "unverified" (OQ-6, OQ-7).

## Desktop gate — `test/desktop/`
- No WebDriver on macOS: `run.ts` serves a command channel on `127.0.0.1:5181`
  (`channel.ts`), and the agent polls it and runs commands in the page. Every hello must be
  `tauri:` with `__TAURI_INTERNALS__`, and the page must be visible; else the run aborts.
- `Driver{browser:'app'}` runs `test/e2e/gate.ts` unchanged: load = reload → hello →
  `gate_open` → loaded; keys are synthetic `keydown`. The app's read rule: a wrong frame
  passes only if flagged stale, and a flag on a right frame fails.
- A seek with no `seeked` after 15 s aborts the suite with its `stream.log` lines (OQ-8).
- `caffeinate -dimu npm run test:desktop -- <suite> [n]`: `launches`, `probe`, `paths`, `big`
  (`$BIG_FIXTURE`, from `scripts/make-big-fixture.sh`), `log`, `gates`, `stale`,
  `openwith-cold`, `openwith-running`. Results: `test-results-desktop/desktop-<suite>.json` (outside `test-results/`, which Playwright empties).
