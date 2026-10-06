# Results

Every number on this page comes from a file under [`docs/results/`](results/) written by a real run. Dev build, iOS Simulator (iPhone 17, iOS 27.0), reference app: an Expo SDK 56 / React Native 0.85.3 / React 19.2.3 / Hermes app with Expo Router and the React Compiler enabled, served from a Fixpoint-managed Metro at `origin/main`.

## What ran, and what did not

| step | status | evidence |
|---|---|---|
| `fixpoint init` + `fixpoint verify` on the reference app, no app edits | ran, all checks green | [DECISIONS.md §Phase 6](DECISIONS.md) |
| Startup capture (cold launch) | ran | [`scan-2026-10-06/startup/findings.json`](results/scan-2026-10-06/startup/findings.json) |
| React Compiler pass over the app source | ran | [`scan-2026-10-06/compiler-bailouts.json`](results/scan-2026-10-06/compiler-bailouts.json) |
| Route scan (second-visit recording per route, default scenario: settle → scroll → settle) | ran: 25 routes recorded, 15 not reached | [`scan-2026-10-06/index.json`](results/scan-2026-10-06/index.json) |
| A/A calibration | **did not run** | no `aa-*.json` exists |
| A/B of a candidate fix | **did not run** | no verdict file exists |
| Draft PRs on the app | **did not run** | none opened |
| Demo videos | **did not run** | none recorded |

The scan was stopped before the optimize loop on request; the A/A, A/B, PR and video steps are implemented and documented but have no results yet. Nothing below claims a speed-up. Those are counts of work the app did while being navigated, which is what the next step (an interleaved A/B of one allow-listed fix) would compare exactly.

## Scan of 2026-10-06

Source: [`results/scan-2026-10-06/`](results/scan-2026-10-06/). 372 route files discovered, 40 selected after the config's excludes, 25 recorded, 15 failed to reach the route (auth-gated onboarding screens, parameterised sub-screens, and one symbolication edge case on `/` fixed afterwards).

Totals over the 25 recorded routes: 74,327 component renders in 500 commits, of which 3,631 renders received deeply equal props or a new callback identity only. 668 findings: 236 `wasted-render`, 125 `render-fanout`, 77 `hot-component`, 225 `compiler-bailout` (9 distinct skipped functions, repeated per route), 3 `long-task`, 2 `frame-drop`.

Startup: 7,826 modules initialised before the first screen reported ready (21.3 s from launch to ready on this machine, dev build with Metro on the loopback), 345 route modules initialised eagerly. Largest packages on the startup path by module count: `lucide-react-native` 1,562, `date-fns` 826, `expo-router` 389, `react-native` 385, `react-native-reanimated` 309, `react-native-calendars` 284.

### Per route

| route | component renders | avoidable renders | JS busy ms | recording ms | top finding |
|---|---|---|---|---|---|
| `/mood/history` | 18259 | 1370 | 2971 | 6973 | render-fanout componentsPerCommit=3993 |
| `/lists/manage` | 5927 | 329 | 1282 | 6227 | render-fanout componentsPerCommit=1419 |
| `/notifications` | 4622 | 285 | 591 | 5180 | render-fanout componentsPerCommit=1468 |
| `/user/timelines` | 3999 | 162 | 507 | 5230 | render-fanout componentsPerCommit=1969 |
| `/user/find-friends` | 3431 | 221 | 626 | 5232 | render-fanout componentsPerCommit=745 |
| `/search/examples` | 3101 | 128 | 468 | 5333 | render-fanout componentsPerCommit=1558 |
| `/user/user-rewards` | 3086 | 44 | 477 | 5527 | render-fanout componentsPerCommit=2003 |
| `/user/user-posts-feed` | 2898 | 122 | 461 | 5195 | render-fanout componentsPerCommit=837 |
| `/user/rewards` | 2775 | 50 | 592 | 6040 | render-fanout componentsPerCommit=858 |
| `/timelines/templates` | 2744 | 140 | 498 | 5083 | render-fanout componentsPerCommit=734 |
| `/user/friends` | 2644 | 70 | 463 | 5226 | render-fanout componentsPerCommit=603 |
| `/timelines/examples` | 2551 | 71 | 381 | 5292 | render-fanout componentsPerCommit=1519 |
| `/user/top-followers` | 2242 | 49 | 414 | 5109 | render-fanout componentsPerCommit=678 |
| `/user/profile` | 1991 | 60 | 370 | 5219 | render-fanout componentsPerCommit=1225 |
| `/streaks-today` | 1982 | 40 | 331 | 5371 | render-fanout componentsPerCommit=932 |
| `/user/store` | 1760 | 44 | 337 | 5139 | render-fanout componentsPerCommit=492 |
| `/user/notification-settings` | 1477 | 62 | 294 | 5075 | render-fanout componentsPerCommit=490 |
| `/user/streaks` | 1393 | 48 | 277 | 5094 | render-fanout componentsPerCommit=498 |
| `/user/settings` | 1346 | 48 | 309 | 5318 | render-fanout componentsPerCommit=629 |
| `/utils/qr-code` | 1155 | 36 | 234 | 5081 | render-fanout componentsPerCommit=421 |
| `/search` | 1154 | 72 | 246 | 5245 | render-fanout componentsPerCommit=431 |
| `/waiting-list` | 1150 | 42 | 229 | 5073 | render-fanout componentsPerCommit=435 |
| `/user/user-rewards/choose` | 1123 | 44 | 241 | 5078 | render-fanout componentsPerCommit=430 |
| `/user` | 1118 | 64 | 229 | 5064 | render-fanout componentsPerCommit=403 |
| `/timelines` | 399 | 30 | 122 | 5068 | render-fanout componentsPerCommit=392 |

Each row's `findings.json` is in `results/scan-2026-10-06/<route-slug>/`. "Avoidable" is the analyzer's deterministic `wasted-render` count: renders whose React-reported props diff contained only deeply equal values, same-type elements, or callbacks React itself flagged as referentially unequal. JS busy time comes from the sampling profiler and is not a comparison metric.

### What the findings say

- **Navigation re-renders the mounted tab tree.** On nearly every route the largest commit is triggered by `BaseNavigationContainer updateSyncExternalStore()` and renders 400 to 2,000 components under the shared `Screen` wrapper; the hottest frames are React's `propagateContextChanges`. That is a navigation-state context fan-out, not a single component, and it needs a design decision rather than an allow-listed recipe.
- **Rows re-render with equal data.** `NotificationRow` and the list cells around it rendered with deeply equal `createdAt`, `readAt`, `syncTime` and `post` props (38 avoidable renders on `/notifications`, 152 on `/mood/history` where the notifications tab re-rendered underneath a modal). Timeline cards show the same with `createdAt`, `updatedAt`, `lastViewedAt`. This is the `stable-row-props` recipe and the first candidate for an A/B.
- **A once-per-second countdown is cheap.** The `ProfileShopMenuOption` tick was suspected to fan out; the commit-by-commit view showed exactly one component per tick (the compiler already isolates it). It was dropped as a candidate, which is the kind of thing the deterministic view is for.
- **React Compiler:** 9 functions skipped out of 1,688 files compiled; one (`DraggableEntry`) co-occurs with a render finding.
- **Startup:** 345 route modules initialise before the first screen; the `lazy-require` recipe applies.

## Reproducing

```bash
# in the app directory, with the dev client open on the booted simulator
fixpoint serve --ref origin/main --port 8091 --dir .       # separate terminal
fixpoint verify --metro http://127.0.0.1:8091
fixpoint scan --metro http://127.0.0.1:8091
fixpoint findings /notifications
```

The config used is the one `fixpoint init` wrote plus the `exclude` list for flow-starting screens; see [DECISIONS.md](DECISIONS.md) for every protocol detail and the three harness fixes the first scan forced (trace cleanup on scenario errors, scroll on screens without a scroll view, error-boundary detection with cold-start recovery).
