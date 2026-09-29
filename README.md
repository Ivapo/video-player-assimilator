# video-player-assimilator

A simple video player under the Assimilator brand. The user picks an mp4 file and it plays.

Two targets from one TypeScript code base:

- Web: static site on GitHub Pages (Vite).
- Desktop: small app (Tauri).

Playback uses the browser `<video>` tag. The file stays on the user's device.
Linux users need their own codec plugins (GStreamer).

Status: idea stage. No code yet.
