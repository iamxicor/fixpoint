#!/usr/bin/env bash
# Usage: scripts/demo/record-sim.sh <name> [udid]   (Ctrl-C to stop)
set -euo pipefail
name=$1; udid=${2:-booted}
out=$(cd "$(dirname "$0")/../.." && pwd)/docs/demo/casts
mkdir -p "$out"
exec xcrun simctl io "$udid" recordVideo --codec=h264 --force "$out/$name-sim.mp4"
