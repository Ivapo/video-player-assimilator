# Evidence — vpa-001 Phase 2 build gate (2026-09-29)

The console output of each gate run on this Mac (macOS 26.6.2, arm64, ~60 Hz). Text only; the
videos are not here. The runner's JSON result files were lost: `npm run test:chrome` empties
`test-results/`, where they were written (the runner now writes to `test-results-desktop/`).
Each log still carries every run's line and the suite's `SUMMARY`.

| file | part | notes |
|---|---|---|
| `block1-E1-E3.log` | E.1–E.3 | The first block. It stopped at E.3's first run, 5/6; the NFC/NFD name read frame 0 (a stale picture before `d` was known). That run's own log was overwritten; its result lines are here. |
| `E1.log` | E.1 | 20 cold launches |
| `E2.log` | E.2 | the scheme probe, 12 cases |
| `E3.log` | E.3 as amended | 6/6: five read frame 10, one stale and warned |
| `E4.log` | E.4 | the 2 GB file: load, 50 seeks, peak RSS |
| `E5.log` | E.5 | `stream.log` checked over E.1–E.4 |
| `E5-parser-bug.log` | E.5, harness bug | the same check before the parser fix (`Content-Range` has a space) |
| `F.log` | F | 27 repetitions of A, B, C(b), C(c): 108 runs, per-run lines |
| `G1.log`, `G2.log` | G | the stale soak, 2 × 50 |
| `H1.log`, `H2.log` | H.1–H.2 | "Open with", cold and running |
| `block2-F-G-H1.log` | F, G, H.1 | the second block. It stopped at H.1's first attempt: a harness bug (`openWith` read before its initialization) that never reached the app. |
| `block3-H-E3-E5.log` | H.1–H.2, E.3, E.5 | the third block. E.5 stopped because E.4 had not been run yet. |
| `W-chrome-run1-failed.log`, `.json` | W, Chrome, run 1 | B.2 failed: the counter stayed `unknown` over 175 gaps |
| `W-chrome-rerun.log` | W, Chrome | the diagnostic re-run, 4/4 |
| `W-safari.log` | W, Safari | 4/4 |
| `w-chrome-x10/` | W, Chrome | the 10 further runs after the B.2 failure: `run-N.log` and `run-N.json` |

The CI build for the branch is GitHub Actions run 36636129673.
