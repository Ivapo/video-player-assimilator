#!/usr/bin/env bash
# Writes the large file for the desktop gate's part E (spec vpa-001 §4, Phase 2) outside the
# repo, to $BIG_FIXTURE (default ~/Movies/vpa-big.mp4), which test/desktop/run.ts reads.
#
#   testsrc2, 1920x1080, 30 fps, 640 s, h264_videotoolbox at 40 Mb/s, yuv420p, and no
#   faststart, so `moov` comes after `mdat`. Spike 2's recipe.
#
# VideoToolbox undershoots its target on testsrc2 (Spike 2's file: 1 093 112 387 bytes), so
# the size is measured, and the script fails unless it is over 10^9 bytes (R1-N2, R2-N3).
set -euo pipefail

FFMPEG="${FFMPEG:-/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg}"
OUT="${BIG_FIXTURE:-$HOME/Movies/vpa-big.mp4}"
mkdir -p "$(dirname "$OUT")"

"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=640" \
  -c:v h264_videotoolbox -b:v 40M -pix_fmt yuv420p \
  "$OUT"

size=$(stat -f %z "$OUT")
# The top-level boxes, in order: moov must come after mdat.
order=$(node -e '
  const fs = require("fs"); const fd = fs.openSync(process.argv[1], "r");
  const size = fs.fstatSync(fd).size; const b = Buffer.alloc(16); let pos = 0; const names = [];
  while (pos + 8 <= size) {
    fs.readSync(fd, b, 0, 16, pos);
    let len = b.readUInt32BE(0); const name = b.toString("latin1", 4, 8);
    if (len === 1) len = Number(b.readBigUInt64BE(8)); else if (len === 0) len = size - pos;
    names.push(name); pos += len;
  }
  console.log(names.join(" "));' "$OUT")
echo "$OUT: $size bytes; boxes: $order"

if [[ "$order" != *"mdat"*"moov"* ]]; then
  echo "error: moov does not come after mdat" >&2
  exit 1
fi
if (( size <= 1000000000 )); then
  echo "error: $size bytes is not over 10^9" >&2
  exit 1
fi
