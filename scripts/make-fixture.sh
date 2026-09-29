#!/usr/bin/env bash
# Writes the Phase 1 test fixtures into test/fixtures/ (spec vpa-001 §2.6).
#
#   frames.mp4      30 fps, 3 s, frames 0–89,   exact timestamps
#   frames120.mp4  120 fps, 2 s, frames 0–239,  exact timestamps
#   frames60ms.mp4  60 fps, 5 s, frames 0–299,  whole-ms timestamps (remuxed from mkv)
#
# Every frame carries a 9-cell bit strip (for the test) and its number (for the eye).
set -euo pipefail

FFMPEG="${FFMPEG:-/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg}"
FFPROBE="${FFPROBE:-$(dirname "$FFMPEG")/ffprobe}"
FONT=/System/Library/Fonts/Supplemental/Arial.ttf
OUT="$(cd "$(dirname "$0")/.." && pwd)/test/fixtures"

# Capture first: `grep -q` exits early, and under pipefail the SIGPIPE would fail the check.
filter_list=$("$FFMPEG" -hide_banner -filters 2>/dev/null || true)
if ! grep -q ' drawtext ' <<<"$filter_list"; then
  echo "error: $FFMPEG has no drawtext filter. Run: brew install ffmpeg-full" >&2
  exit 1
fi
mkdir -p "$OUT"

# Black 360x40 bar in the top-left, then cell b (32x32 at x=40b+4, y=4) white when
# bit b of the frame number n is set.
filters="drawbox=x=0:y=0:w=360:h=40:color=black:t=fill"
for b in 0 1 2 3 4 5 6 7 8; do
  filters+=",drawbox=x=$((40 * b + 4)):y=4:w=32:h=32:color=white:t=fill:enable='eq(mod(floor(n/$((1 << b))),2),1)'"
done
filters+=",drawtext=fontfile=$FONT:text='%{n}':fontsize=96:fontcolor=white:box=1:boxcolor=black@0.6:x=(w-tw)/2:y=(h-th)/2"

encode() { # rate seconds output
  "$FFMPEG" -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc=size=640x360:rate=$1:duration=$2" \
    -vf "$filters" -c:v libx264 -pix_fmt yuv420p -r "$1" "$3"
}

encode 30 3 "$OUT/frames.mp4"
encode 120 2 "$OUT/frames120.mp4"
encode 60 5 "$OUT/frames60.mkv"
"$FFMPEG" -hide_banner -loglevel error -y -i "$OUT/frames60.mkv" -c copy \
  -video_track_timescale 1000 "$OUT/frames60ms.mp4"

# Self-check against the values §2.6 pins.
fail=0
check() { # file time_base r_frame_rate nb_frames duration
  local got
  got=$("$FFPROBE" -v error -select_streams v:0 -count_packets \
    -show_entries stream=time_base,r_frame_rate,nb_frames,pix_fmt:format=duration \
    -of default=nw=1 "$OUT/$1" | sort | tr '\n' ' ')
  local want="duration=$5 nb_frames=$4 pix_fmt=yuv420p r_frame_rate=$3 time_base=$2 "
  if [[ "$got" == "$want" ]]; then
    echo "ok   $1: $got"
  else
    echo "FAIL $1: got  $got" >&2
    echo "     $1: want $want" >&2
    fail=1
  fi
}
check frames.mp4     1/15360 30/1  90  3.000000
check frames120.mp4  1/15360 120/1 240 2.000000
check frames60ms.mp4 1/1000  60/1  300 4.999000
exit $fail
