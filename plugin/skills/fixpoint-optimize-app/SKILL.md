---
name: fixpoint-optimize-app
description: Run the Fixpoint optimize-screen loop over every navigable route of this React Native app, ranked by impact, one draft PR per screen. Use when asked to optimize the whole app or every screen.
argument-hint: [--max-routes <n>] [--pairs <n>]
---

# /fixpoint:optimize-app

1. `fixpoint_verify`, then `fixpoint_scan` (all routes). This cold-starts the app once for the startup capture and records every route; it takes a few minutes.
2. Rank routes by the score of their top finding (`fixpoint_findings` without a route returns every route). Skip routes whose top finding has no applicable recipe.
3. For each route in that order, run the `/fixpoint:optimize-screen` procedure exactly, including branch, gates, A/B, PR or revert. One PR per screen; start every branch from the same base branch so PRs stay independent.
4. Stop after `--max-routes` routes (default 3) or when two routes in a row produce no accepted fix.
5. Finish with `/fixpoint:report` and a summary table: route, finding, recipe, verdict, PR link. Rejected and inconclusive runs stay in the table.

Everything in the optimize-screen rules applies: one allow-listed fix per PR, draft PRs only, revert on anything but accept, every number labelled "dev build, iOS Simulator".
