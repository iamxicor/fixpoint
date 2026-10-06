# LinkedIn post

Every number below comes from `docs/results/scan-2026-10-06/` (see [RESULTS.md](RESULTS.md)). The A/B, PR and video numbers from the original draft were deleted because those steps did not run yet; nothing here is estimated. All numbers: dev build, iOS Simulator.

## Short (under 120 words)

Last month I posted an agent that drives the iOS Simulator. Here's what I built with it.

Fixpoint: an open-source harness that lets a React Native app measure itself. It reads React Native DevTools traces, turns them into deterministic findings (render counts, not milliseconds), and is wired to apply one allow-listed fix, A/B it against the original on the same simulator with an A/A noise floor first, and open a draft PR only if the win survives the gates.

First scan of our app: 25 screens, 74,327 component renders, 3,631 of them with props that were deeply equal. One screen rendered 3,993 components in a single commit.

Dev builds, iOS only. MIT. Link in the first comment.

## Standard

Last month I posted an agent that drives the iOS Simulator. A few people asked what I'd do with it.

Here's the answer. Fixpoint: an open-source harness that makes a React Native app measure itself, and is built to fix itself.

It connects to React Native DevTools, records the render waterfall and JS flamegraph for every screen, and turns them into findings an agent can act on: render fan-outs, renders with deeply equal props, hot components, startup modules, React Compiler bailouts. The loop after that is wired and documented: apply one allow-listed fix, re-measure it against the original on the same simulator, interleaved, A B A B, with an A/A calibration first, and open a draft PR with the video attached only if the win survives the gates. No human in the middle until review.

First scan of our app (dev build, iOS Simulator):
• 25 screens recorded, 74,327 component renders, 3,631 of them with deeply equal props
• Worst screen: 3,993 components rendered in one commit
• 7,826 modules initialised before the first screen; 345 of them are other routes
• React Compiler skipped 9 functions out of 1,688 files

Three things building it taught me:
1. Don't measure time. Measure work. Render counts have no error bar.
2. Run A/A before A/B. Your noise floor is the real threshold.
3. The model isn't the story. The harness is.

Dev builds and iOS only for now. MIT. Repo in the first comment.

#ReactNative #Expo #AIAgents #Performance #MCP

## First comment

Repo: https://github.com/iamxicor/fixpoint
The measurement method, if you only read one page: https://github.com/iamxicor/fixpoint/blob/main/docs/MEASUREMENT.md
Every number in the post traces to a JSON file here: https://github.com/iamxicor/fixpoint/tree/main/docs/results
The A/B and the before/after video come next; I'll post them when the verdict files exist.
