# How Fixpoint measures

The point of Fixpoint is not that an agent can suggest `useMemo`. It is that the loop closes: every suggested fix is measured against the original on the same simulator, interleaved, and only a win that survives the gates becomes a pull request. This page is the measurement method in full. Nothing in it is optional in the code; the config can tune thresholds but cannot turn a step off.

## 1. Work, not time

Time on a developer machine is noisy: thermal state, other processes, Metro's own activity, the simulator's frame pacing. A 10 % time improvement on one run means nothing.

So the primary metrics are **counts of work** that React itself reports through its performance tracks:

- `componentRenders`: Components ⚛ entries whose render window falls inside a Scheduler ⚛ Render phase.
- `avoidableRenders`: renders whose props diff (React 19.2 attaches it) contains only deeply equal values, same-type elements, or functions React flagged as referentially unequal closures.
- `commits`: Scheduler ⚛ Render phases.
- `maxComponentsPerCommit`: the largest fan-out.

For the same code and the same scenario these numbers are the same on every run (the A/A calibration checks it). They are compared **exactly**: a fix is accepted only if every pair agrees on the direction. No error bars needed.

Time is still reported, as the secondary metric `renderMs` (Σ Render + Commit + Remaining Effects phase durations), with a 95 % bootstrap confidence interval and a Wilcoxon signed-rank p-value over the paired differences. Time never carries a verdict on its own unless the counts did not move and the CI is clear of zero by more than the noise floor.

## 2. Visit discipline

A screen's first visit pays for lazy module initialisation (`lazy=true` bundles, inline requires). If that cost lands in one variant and not the other, the A/B is a lie. Every measured visit is therefore the **second** visit: navigate to the route, settle, go back, then navigate again and record. Startup metrics are the opposite: always a cold launch (`simctl terminate`, then the dev-client deep link), never a reload, because the reference app segfaults on JavaScript reload and because reload keeps module state alive.

## 3. Two Metro servers, one simulator, interleaved

An A/B runs base and candidate from two git worktrees, each served by its own Metro on its own port, against the same simulator and the same installed dev client. Switching is a cold start through `scheme://expo-development-client/?url=<metro>`. The order is A B A B A B: environmental drift that creeps in over minutes hits both variants equally. The first pair is recorded with full instrumentation and **discarded** from the statistics; it exists for the control-frame check, the screenshots and the video. Six measured pairs by default, configurable.

Deep links into the app are not used for navigation; the harness calls Expo Router's own `router.navigate` through DevTools, which means the app needs no test hooks and the route reached is verified through the router store before recording starts.

## 4. A/A calibration

Before any A/B on a route, the harness runs base against base with exactly the same procedure. The observed spread is the **noise floor**: the 95th percentile of |relative pair difference| for `renderMs`, and the same for every count (which should be zero). The acceptance threshold for time is `max(minEffect, noiseFloor)`, never a hard-coded number. If the A/A itself shows a significant difference, the harness, not the app, has failed, and no A/B is accepted until it is fixed.

## 5. Control frames

In the full-instrumentation pair, the sampling profiler's self time per symbolicated function is compared between base and candidate, restricted to files the candidate diff did **not** touch. Those frames have no reason to move. If their total drifts by more than `maxControlDrift` (25 % by default), the pair is discarded as environment drift and re-recorded, up to three attempts; if the drift persists the verdict is `inconclusive`. Frames in touched files are free to change; that is the fix.

## 6. Replay proxy

Real screens read real APIs. To keep both variants on the same data, a local HTTP proxy sits in front of the API: `record` mode stores every response keyed by method, path and body hash; `replay` mode serves them and **never forwards**. Reads without a recording get a 404 with `x-fixpoint-replay: miss`; writes without a recording get an empty 200 stub. The app's API base URL is overridden through the `EXPO_PUBLIC_*` variable Metro inlines, so the app binary is untouched. Scenarios are read-only by construction (wait, scroll, tap, back, navigate), and the proxy guarantees that even a tap on a mutating control cannot reach a backend in replay mode.

## 7. Two passes

Diagnosis uses everything: sampling profiler, user timing with props diffs, scheduler stacks, optional heap snapshots. That instrumentation has a cost, and it is the same for both variants, but it still inflates the numbers. Verification therefore records **light counters only** (`devtools.timeline` and `blink.user_timing`), which is enough for every count and for `renderMs`. Published time numbers come from the light pass.

## 8. Gates

All of these must pass before a pull request is opened:

1. typecheck (the app's own script),
2. lint (the app's own script),
3. existing tests when runnable,
4. pixel diff of the settled screenshot, base vs candidate, at most 0.5 % differing pixels (`pixelmatch`),
5. A/B verdict `accept`.

The PR is always a **draft**. Nothing merges without a human.

## 9. Verdict

`accept` when a deterministic count improved in every pair and time did not regress beyond the noise floor; or when counts are unchanged and time improved with the CI clear of zero and the effect above the floor. `reject` when any count regressed or time regressed beyond the floor. `inconclusive` otherwise, including when control frames drifted or fewer than three pairs survived. Rejected and inconclusive verdicts are written to the same `docs/results/` directory as accepted ones and appear in RESULTS.md.

## 10. What it cannot see

- The native main thread: layout, image decoding, text measurement, shadow tree commits. Fixpoint measures the JavaScript side of a React Native app.
- Release-build behaviour: Hermes bytecode, no dev-mode checks, React production mode. Every number is from a dev build on the iOS Simulator and is labelled so.
- Frame timing: React Native 0.85 does not emit frame events in CDP traces; `frame-drop` falls back to JavaScript busy runs longer than one frame during the scroll window and says so.
- Android, bare React Native, physical devices: out of scope for v1.

## 11. Reproducing a number

Every verdict JSON records the refs and shas, the Metro URLs, the scenario, every pair's metrics, the noise floor and its source file, the control-frame comparison, the pixel ratio, the trace file for every visit, and any foreign simulator events the log showed during the run. `fixpoint report` renders RESULTS.md from those files and nothing else.
