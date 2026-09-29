# video-player-assimilator

A simple video player under the Assimilator brand. Pick an mp4 file, play it, and step it
one frame at a time.

**Web:** https://ivapo.github.io/video-player-assimilator/

The file plays on your own device, in the browser's `<video>` tag. Nothing is uploaded.
A desktop app (Tauri) from the same code is planned.

## Using it

- **Open mp4…** or drop a file on the page.
- Space plays and pauses. `.` or → steps forward one frame; `,` or ← steps back.
- Stepping stays off until the player has measured the frame rate. That takes a moment of
  playback: about 0.3 s for a typical file, about 2.2 s for one with millisecond timestamps
  (common for files remuxed from mkv or webm). The readout says "measuring frame rate…"
  until then.
- Steps assume a constant frame rate.

## Browser support

- **Chrome: fully supported.**
- **Safari: works, with one known limitation.** After a seek or a step while paused, Safari
  sometimes keeps showing the previous picture. The frame number the player reports is still
  right, but the image is not. When this happens the player says so: *"Safari didn't update
  the picture: the frame shown may be wrong"*. Pressing play clears it. We measured it and
  could not work around it (re-seeking and play/pause do not help).
  - Safari also skips one safety check, so a file with a frame rate above your display's
    refresh rate (for example 120 fps on a 60 Hz screen) may step at the wrong rate.
    Chrome refuses such files instead.
- Other browsers: not tested. Frame stepping needs `requestVideoFrameCallback`; without it,
  the player plays but says it cannot step frames.
- It plays only what the browser can decode (H.264 mp4 everywhere). Linux desktop builds
  will need the system's GStreamer codecs.

## Development

```sh
npm install
npm run dev            # http://localhost:5173/video-player-assimilator/
npm run build          # static site in dist/
npm test               # unit tests (Vitest)
npm run fixtures       # regenerate test/fixtures/*.mp4 (needs brew install ffmpeg-full)
npm run test:chrome    # browser gate in installed Google Chrome (Playwright)
npm run test:safari    # browser gate in Safari.app (safaridriver --enable, Allow Remote Automation)
```

Pushing to `main` deploys the site through `.github/workflows/pages.yml`.

The design and its reasoning are in `specs/player_spec.md`; what the code does now is in
`rules/player.md`.

License: MIT.
