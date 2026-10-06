---
name: fixpoint-optimize-screen
description: Run the Fixpoint loop on one route of this React Native app. Picks the top finding from the latest scan, creates a branch, applies exactly one allow-listed fix, runs the gates and an interleaved A/B, then opens a draft PR only if the verdict is accept, otherwise reverts. Use when asked to optimize, speed up or fix performance of a specific screen or route.
argument-hint: <route> [--finding <id>] [--pairs <n>]
---

# /fixpoint:optimize-screen `<route>`

You are the agent in the Fixpoint loop. The harness measures; you choose and apply one fix. You never read a raw trace: `fixpoint_findings` gives you `findings.json`, and every number you quote comes from a verdict file.

## Rules that do not bend

1. **One fix per PR, from the allow-list** in `docs/FIX-RECIPES.md`: `remove-compiler-bailout`, `stable-row-props`, `move-state-down`, `lazy-require`, `list-config`, `hoist-literals`, `remove-redundant-effect`, `subscription-cleanup`. Business logic, data-fetching semantics and navigation structure are off limits. If the top finding has no applicable recipe, take the next one and say why.
2. **Never auto-merge. Always a draft PR.** Never open a PR on a repository other than the app's own without asking.
3. **Revert on reject or inconclusive.** A fix that does not survive the A/B is deleted, not "left for later". Record the verdict file in the report anyway.
4. **Label every number** "dev build, iOS Simulator". Time numbers only with their CI.

## Procedure

1. Preconditions: the dev client is open on the booted simulator and Metro is running. Call `fixpoint_verify`; stop and report if it fails.
2. Findings: call `fixpoint_findings` with `route`. If there is no scan for that route, call `fixpoint_scan` with `route` first. Present the ranked table (top 10) to the user in one message.
3. Pick the top finding whose `suggestedFixes` contains a recipe you can apply within its *when* conditions. Read the recipe's *how*, *risk* and *evidence required*. Use `location`, `evidence.components` and `evidence.frames`; open those files.
4. Branch: `git switch -c fixpoint/<route-slug>-<recipe-id>` from the current base branch (the branch the user is on; call it `BASE`). Commit nothing else.
5. Apply the recipe, minimal diff, one component or module. Keep the public behaviour identical. Commit with a conventional message that names the finding id and recipe id.
6. Gates, fast ones first: `fixpoint_gates` with `candidateDir` = the app directory (the branch is checked out there) and `skipTests: false`. If typecheck or lint fail, fix the diff or revert; do not weaken lint.
7. A/B: `fixpoint_ab` with `candidateRef` = your branch, `baseRef` = `BASE`, `route`, `video: true`. If no A/A exists for the route the harness runs one first; report its noise floor. Then call `fixpoint_gates` again with `verdictFile` so the pixel gate and the A/B verdict are included.
8. Decide:
   - `accept` and all gates pass → `fixpoint_pr_body` with the verdict, findings file, finding id, recipe id, gates report, and the video path; then `gh pr create --draft --base BASE --title "<title>" --body-file <file>` with the side-by-side video and gzipped traces attached (upload the video to the PR with `gh pr comment --body-file` + the file as a release asset if attachments are not possible; say which). Add the label "dev build, iOS Simulator" in the body, not as a GitHub label.
   - `reject` or `inconclusive` → `git switch BASE && git branch -D <branch>`; report the verdict and reasons; if the finding has another recipe, you may try once more, then stop.
9. Report in one message: finding, recipe, deterministic deltas table, time delta with CI, noise floor, gates checklist, verdict file path, PR URL or "reverted".

## Hints

- `componentRenders` and `avoidableRenders` are what a fix must move; `renderMs` is the secondary metric.
- `wasted-render` on a library component (CellRenderer, VirtualizedListCellContextProvider) points at the app component in `location.symbol` ("X via Y"); fix the owner.
- A `compiler-bailout` finding that shares a name with a render finding is usually the cheapest win: remove the bailout cause and the React Compiler memoises the whole component.
