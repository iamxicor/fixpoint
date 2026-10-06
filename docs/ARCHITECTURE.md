# Architecture

```
                    ┌─────────────────────────────────────────────────────────────┐
                    │ agent (Claude Code plugin skills, or any MCP client)        │
                    │   reasons over findings.json only; applies one recipe       │
                    └───────────────┬──────────────────────────┬──────────────────┘
                                    │ MCP (stdio)              │ CLI
                           packages/mcp                     packages/cli
                                    └──────────┬───────────────┘
                                               ▼
                                       packages/harness
   routes · config · scenarios · simulator (simctl, idb) · worktrees + Metro · replay proxy
   app session (cold start, router navigation, CDP scroll/tap) · scan · A/B runner · stats
   control frames · gates (typecheck, lint, tests, pixelmatch) · PR body · baseline · report · video
            │                                   │
            ▼                                   ▼
     packages/devtools                   packages/analyzer
   Metro targets · Origin discovery      trace model (commits, component tree, props diffs,
   CDP connection · tracing · profiler   scheduler updates + setState stacks, samples)
   heap · runtime probes · Expo Router   eight detectors · ranking · findings.json · tables
   via module registry · symbolication  heap aggregation (nodes + strings only)
            │
            ▼
   Metro inspector proxy ──► React Native DevTools (Fusebox) ──► Hermes + React 19.2 tracks
```

## Packages

| package | responsibility | talks to |
|---|---|---|
| `@fixpoint/devtools` | everything protocol: listing targets, opening a debugger socket with the right Origin, `Tracing`, `Profiler`, `HeapProfiler`, `Runtime.evaluate` helpers, Expo Router navigation through Metro's module registry, source-map symbolication | Metro over HTTP/WebSocket |
| `@fixpoint/analyzer` | pure functions from recordings to ranked `findings.json`; never touches the network or the simulator | nothing |
| `@fixpoint/harness` | the measurement method: scenarios, cold starts, scans, A/A and A/B, statistics, gates, reports | simulator (`xcrun simctl`, optional `idb`), git, Metro processes, the app's own scripts |
| `fixpoint` (CLI) | `init`, `verify`, `routes`, `scan`, `findings`, `analyze`, `ab`, `aa`, `gates`, `pr-body`, `baseline`, `report` | harness |
| `@fixpoint/mcp` | the same operations as MCP tools for any agent | harness |
| `plugin/` | Claude Code plugin: six skills and the MCP registration | MCP server |

## Data flow of one `optimize-screen` run

1. `scan` cold-starts the app for the startup capture, then for each route: warm visit, measured second visit under full tracing, analyzer → `findings.json` (with symbolicated frames and the app's own component index), screenshot of the settled screen.
2. The agent picks the top finding with an applicable recipe and applies it on a branch.
3. `gates` run the app's typecheck, lint and tests.
4. `ab` prepares two worktrees (node_modules cloned with APFS clonefile, dev env files copied), starts a replay proxy if configured, two Metro servers, and runs the A/A (if missing) and the A/B. Every visit is a cold start through the dev-client deep link; the route is reached through Expo Router's API; the first pair is full instrumentation and discarded; the rest are light counters.
5. Statistics and the control-frame check produce a verdict JSON in `docs/results/`.
6. The pixel gate and the verdict feed `gates` again; if everything passes, `pr-body` renders the pull request and the agent opens it as a draft with the video and traces attached.

## Why these boundaries

- **The analyzer is pure** so that findings are reproducible from fixtures in CI and the agent never needs the simulator to reason.
- **The devtools package knows the protocol quirks** (Origin header, page ids, Debugger domain, 1-based lines) in one place; see `DECISIONS.md` §0.
- **The harness owns the method**: there is no code path that opens a PR without `decide()` having returned `accept`, and no code path that forwards a request in replay mode.
- **MCP over stdio** keeps the agent layer thin and vendor-neutral; the plugin only adds procedure and constraints.

## Where things land

```
~/.cache/fixpoint/<app>/        (default outDir; set `outDir` in the config to move it)
  scan/<route>/{findings.json, trace.json.gz, settled.png, marks.json}
  scan/startup/{startup-capture.json, findings.json}
  scan/compiler-bailouts.json
  scan/index.json
  aa/<route>-<ts>/…     ab/<route>-<ts>/{pair-*.trace.json.gz, A-settled.png, B-settled.png, side-by-side.mp4, verdict.json}
  results/{aa-latest-<route>.json, <route>-<ts>.json}
  worktrees/{base,candidate}
  replay/<sha1>.json
```
