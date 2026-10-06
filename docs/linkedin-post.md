# LinkedIn post

Every number below must come from a file in `docs/results/`. Bracketed values are placeholders until the run that produces them exists; a line whose number never materialised is deleted, not estimated. Labels: dev build, iOS Simulator.

## Short (under 120 words)

Last month I posted an agent that drives the iOS Simulator. Here's what I built with it.

Fixpoint: an open-source harness that makes a React Native app optimise itself. It reads React Native DevTools traces, turns them into deterministic findings (render counts, not milliseconds), applies one allow-listed fix, then re-measures it against the original on the same simulator, interleaved, A B A B, with an A/A noise floor first. Only a win that survives the gates becomes a draft PR, video attached.

First run on our app: [route]: [N] renders per visit → [M]. [K] screens scanned, [P] PRs opened.

Dev builds, iOS only. MIT. Link in the first comment.

## Standard

Last month I posted an agent that drives the iOS Simulator. A few people asked what I'd do with it.

Here's the answer. Fixpoint: an open-source harness that makes a React Native app optimise itself.

It connects to React Native DevTools, records the render waterfall and JS flamegraph for every screen, finds the waste, applies a fix, then re-measures the fix against the original on the same simulator, interleaved, A B A B, until the result stops changing. Only then does it open a PR, with the before/after video attached. No human in the middle until review.

First run on our app:
• [route]: [N] renders per visit → [M]
• JS render time on that screen: [−X]% (95% CI [lo–hi])
• [K] screens scanned, [P] PRs opened, [Q] merged

Three things building it taught me:
1. Don't measure time. Measure work. Render counts have no error bar.
2. Run A/A before A/B. Your noise floor is the real threshold.
3. The model isn't the story. The harness is.

Dev builds and iOS only for now. MIT. Repo and video in the first comment.

#ReactNative #Expo #AIAgents #Performance #MCP

## First comment

Repo: https://github.com/iamxicor/fixpoint
Video: [release asset URL]
Measurement method, if you only read one page: https://github.com/iamxicor/fixpoint/blob/main/docs/MEASUREMENT.md
Every number in the post traces to a JSON file here: https://github.com/iamxicor/fixpoint/tree/main/docs/results
