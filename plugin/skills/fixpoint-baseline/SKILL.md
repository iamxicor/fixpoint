---
name: fixpoint-baseline
description: Store Fixpoint's per-route deterministic render metrics from the latest scan as a baseline, and explain how to use `fixpoint baseline check` as a regression guard in CI. Use when asked to lock in current performance or add a perf regression check.
---

# /fixpoint:baseline

1. Make sure there is a fresh scan (`fixpoint_findings` lists routes; if empty run `/fixpoint:scan`).
2. `fixpoint_baseline` writes `fixpoint-baseline.json` in the app: for every scanned route, `componentRenders`, `avoidableRenders`, `commits` and `maxComponentsPerCommit` from the measured visit. Only deterministic counts are stored; no times.
3. Explain the guard: `fixpoint scan && fixpoint baseline check` exits 1 when any count grows. Counts are exact, so the check has no flakiness budget; a legitimate increase means re-running `fixpoint baseline write` on purpose, in the same PR that changes the screen.
4. Offer to commit the baseline file. Do not commit it without asking.
