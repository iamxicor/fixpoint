---
name: fixpoint-init
description: Set up Fixpoint for this React Native app: detect Expo and React Native versions, scheme, bundle id, Metro port and routes, write fixpoint.config.ts, then verify the connection to the running dev build. Use when asked to install, set up or verify Fixpoint.
argument-hint: [--force]
---

# /fixpoint:init

1. Run `npx fixpoint init` in the app directory (or `node <fixpoint repo>/packages/cli/dist/bin.js init` for a local clone). It writes `fixpoint.config.ts` once; pass `--force` to overwrite. It edits nothing else.
2. Read the summary it prints. If the bundle id or scheme could not be detected, open `app.config.*` and fill them in by hand; they are the only required fields.
3. Make sure the dev client is open on the booted simulator and Metro is running (`expo start --dev-client`).
4. Call `fixpoint_verify`. Explain each line of the checklist to the user in plain language. Typical failures and what they mean:
   - `metro unreachable`: Metro is not running on the configured port.
   - `target: none for <device>`: the app is not connected to this Metro, or a different simulator is booted; a physical device on the same Metro is ignored on purpose.
   - `debugger`: the Origin header was rejected; see `docs/DECISIONS.md` §0.2.
   - `react-tracks`: React 19.2+ with `console.timeStamp` support is needed for the Components ⚛ / Scheduler ⚛ tracks.
5. End with the next step: `/fixpoint:scan` or `/fixpoint:optimize-screen <route>`.
