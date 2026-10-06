#!/usr/bin/env bash
# Usage: scripts/demo/record-terminal.sh <name> [--cols 100] [--rows 32] -- <command…>
# Records the command with asciinema, renders to GIF with agg, then to MP4 with ffmpeg.
set -euo pipefail
name=$1; shift
cols=100; rows=32
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cols) cols=$2; shift 2;;
    --rows) rows=$2; shift 2;;
    --) shift; break;;
    *) break;;
  esac
done
out=$(cd "$(dirname "$0")/../.." && pwd)/docs/demo/casts
mkdir -p "$out"
cast="$out/$name.cast"
rm -f "$cast"
asciinema rec --cols "$cols" --rows "$rows" --overwrite -c "$*" "$cast"
agg --theme monokai --font-size 18 --speed 1 "$cast" "$out/$name.gif"
ffmpeg -y -loglevel error -i "$out/$name.gif" -movflags +faststart -pix_fmt yuv420p -vf "pad=ceil(iw/2)*2:ceil(ih/2)*2" -c:v libx264 -crf 23 "$out/$name.mp4"
echo "$out/$name.mp4"
