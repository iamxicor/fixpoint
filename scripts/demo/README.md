# Demo recording

Two outputs in `docs/demo/`: `fixpoint-30s.mp4` (30–45 s, captions, no narration) and `fixpoint-walkthrough.mp4` (2–3 min). Terminal on the left, simulator on the right.

Pipeline (all local, no app edits):

1. `record-terminal.sh <name> <command…>` records a CLI run with asciinema into `casts/<name>.cast`, renders it with `agg` to a GIF, then to an H.264 MP4 with ffmpeg.
2. The simulator side comes from `xcrun simctl io <udid> recordVideo` started by `record-sim.sh <name>` and stopped with Ctrl-C (or from the A/B's own `A.mp4`/`B.mp4` recordings).
3. `compose.sh` stacks terminal and simulator side by side (`hstack`), burns the beat captions (`drawtext` with `enable=between(t,…)`), and exports H.264 under 50 MB plus a README GIF under 10 MB.

Beats for the 30-second cut: init → green verify; `/fixpoint:optimize-screen` findings table; the diff; interleaved A/B with the A B A B indicator; verdict card; PR appearing.
