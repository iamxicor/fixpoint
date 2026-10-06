---
name: fixpoint-report
description: Render Fixpoint's results (every A/A, A/B verdict and the latest scan) into a markdown report, with links to the verdict JSON files. Use when asked to summarise what Fixpoint found or changed.
argument-hint: [--out <file>]
---

# /fixpoint:report

1. `fixpoint_report` (pass `out` when the user wants a file, for example `docs/RESULTS.md`, and `linkBase` so links are relative to that file).
2. Present the markdown. Keep rejected and inconclusive verdicts in; honesty is the point.
3. Every number must trace to a file under the results directory. If a measurement did not run, say so instead of estimating.
