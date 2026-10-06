---
name: fixpoint-scan
description: Record and analyse the React Native app's screens with Fixpoint and present the ranked findings. Use when asked what is slow, where the wasted renders are, or to profile a screen or the whole app.
argument-hint: [route]
---

# /fixpoint:scan `[route]`

1. `fixpoint_verify` first; stop if it fails.
2. `fixpoint_scan` with the route if one was given, otherwise all. The harness navigates through Expo Router's own API (no deep links, no taps unless configured), measures the second visit of each route, and never writes to a backend.
3. `fixpoint_findings` (`table: true`) and present, per route, the top findings with: kind, primary metric and whether it is deterministic, location, suggested recipes, and the one-paragraph summary of the top finding. Mention the `notes` (for example when long tasks were derived from sampling runs because the event loop emitted no RunTask events).
4. Do not propose code changes here. Offer `/fixpoint:optimize-screen <route>` for the route with the highest-scoring finding.

Every number: dev build, iOS Simulator. Time-based metrics are marked `~` and are only comparable through an A/B.
