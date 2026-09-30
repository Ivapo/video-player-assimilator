# video-player-assimilator

A simple video player under the Assimilator brand. Pick an mp4 file, play it, and step it
one frame at a time.

**Web:** https://ivapo.github.io/video-player-assimilator/

**Desktop:** macOS, Windows and Linux builds on the
[Releases](https://github.com/ivapo/video-player-assimilator/releases) page.

The file plays on your own device, in the browser's (or the app's) `<video>` tag. Nothing is
uploaded.

## Using it

- **Open mp4…** or drop a file on the page.
- Space plays and pauses. `.` or → steps forward one frame; `,` or ← steps back.
- Stepping stays off until the player has measured the frame rate. That takes a moment of
  playback: about 0.3 s for a typical file, about 2.2 s for one with millisecond timestamps
  (common for files remuxed from mkv or webm). The readout says "measuring frame rate…"
  until then.
- Steps assume a constant frame rate.

## Desktop app

Download from [Releases](https://github.com/ivapo/video-player-assimilator/releases):
`.dmg` for macOS (Apple silicon), `.msi` or the `.exe` installer for Windows, and `.deb`,
`.rpm` or AppImage for Linux.

- **Tested on macOS only.** The Windows and Linux builds are built but have not been run:
  they are **unverified**.
- **The builds are unsigned.** Your system will warn you the first time:
  - **macOS:** open the app once; when macOS blocks it, go to System Settings → Privacy &
    Security and click **Open Anyway**. If macOS says the app **"is damaged"** instead, run
    `xattr -dr com.apple.quarantine "/Applications/Video Player Assimilator.app"` in
    Terminal, then open it again.
  - **Windows:** SmartScreen says "Windows protected your PC": click **More info**, then
    **Run anyway**.
- **Linux** plays video through GStreamer: install your distribution's GStreamer plugins
  for H.264 (for example `gstreamer1.0-libav` and `gstreamer1.0-plugins-bad`).
- **Opening a file:** use **Open mp4…** in the app, or in Finder right-click an mp4 →
  **Open With** → Video Player Assimilator. The app has no drag-and-drop yet.
- **Double-click** opens the app only if you make it the default for mp4 files. In Finder,
  select an mp4 → File → **Get Info** → "Open with:" → choose Video Player Assimilator →
  **Change All…**. (macOS does not let an app make itself the default.)

## Browser support

- **Chrome: fully supported.**
- **Safari and the macOS app: work, with Safari's known limitations.** Both use the same
  system WebKit.
  - After a seek while paused, WebKit sometimes keeps showing the previous picture. The frame
    number the player reports is still right, but the image is not. When this happens the
    player says so: *"The picture may not have updated after this seek. The frame number is
    correct."* Pressing play clears it. We measured it and could not work around it
    (re-seeking and play/pause do not help). The warning needs the frame rate: a seek made
    before the player has measured it can leave a stale picture with no warning.
  - WebKit also skips one safety check, so a file with a frame rate above your display's
    refresh rate (for example 120 fps on a 60 Hz screen) may step at the wrong rate.
    Chrome refuses such files instead.
- **Windows and Linux apps: unverified.**
- Other browsers: not tested. Frame stepping needs `requestVideoFrameCallback`; without it,
  the player plays but says it cannot step frames.
- It plays only what the browser or the system webview can decode (H.264 mp4 everywhere;
  Linux needs the GStreamer codecs).

## Development

```sh
npm install
npm run dev            # http://localhost:5173/video-player-assimilator/
npm run build          # static site in dist/
npm test               # unit tests (Vitest)
npm run fixtures       # regenerate test/fixtures/*.mp4 (needs brew install ffmpeg-full)
npm run test:chrome    # browser gate in installed Google Chrome (Playwright)
npm run test:safari    # browser gate in Safari.app (safaridriver --enable, Allow Remote Automation)

# Desktop (needs the Rust toolchain)
npm run tauri dev                      # the app, from the dev server
npm run tauri -- build --bundles app   # the release .app in src-tauri/target/
(cd src-tauri && cargo test)           # after npm run build:desktop
npm run tauri:gate                     # the gate build, in src-tauri/target-gate/
caffeinate -dimu npm run test:desktop -- gates 27   # the desktop gate (see rules/desktop.md)
```

Pushing to `main` deploys the site through `.github/workflows/pages.yml`, and builds the
desktop app on three OSes through `.github/workflows/desktop.yml`. A pushed `v*` tag attaches
the unsigned bundles to a GitHub Release.

The design and its reasoning are in `specs/player_spec.md`; what the code does now is in
`rules/player.md` and `rules/desktop.md`.

License: MIT.
