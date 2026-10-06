#!/usr/bin/env bash
# Usage: scripts/demo/compose.sh <terminal.mp4> <simulator.mp4> <out.mp4> <captions.txt> [height]
# captions.txt: one caption per line as "start,duration,text"
set -euo pipefail
term=$1; sim=$2; out=$3; caps=$4; h=${5:-1080}
esc() { sed -e "s/\\\\/\\\\\\\\/g" -e "s/:/\\\\:/g" -e "s/'/\\\\'/g" <<<"$1"; }
filters=""
while IFS=, read -r start dur text; do
  [[ -z "$start" ]] && continue
  t=$(esc "$text")
  filters+=",drawtext=text='${t}':fontsize=38:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=16:x=(w-text_w)/2:y=h-th-48:enable='between(t,${start},$(python3 -c "print(${start}+${dur})"))'"
done < "$caps"
ffmpeg -y -loglevel error -i "$term" -i "$sim" -filter_complex "[0:v]scale=-2:${h}[l];[1:v]scale=-2:${h}[r];[l][r]hstack=inputs=2${filters}[v]" -map "[v]" -c:v libx264 -crf 23 -preset veryfast -pix_fmt yuv420p -movflags +faststart "$out"
echo "$out"
