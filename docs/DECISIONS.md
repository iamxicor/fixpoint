# Decisions

What Fixpoint chose and why, including every protocol detail that was verified against a real app. Newest entries at the bottom of each section. Dates are absolute.

Reference app for all verification: `/Users/himanshukushwah/Documents/GitHub/mobile` (Expo SDK 56.0.14, React Native 0.85.3, React 19.2.3, Hermes "Static Hermes" OSS 250829098.0.10, React Compiler on, Expo Router 56.2.13, expo-dev-client 56.0.22, Metro served by `expo start --dev-client` on port 8081). Simulator: iPhone 17, iOS 27.0, udid `4DD3F9F2-64C8-4AD9-85DB-1A9D3BE4B8AA`.

---

## Phase 0 — Feasibility spike (2026-10-06)

Scripts and raw outputs are in `fixtures/phase0/`. Large raw artefacts (the 59.6 MB source map, a 230 MB heap snapshot) were kept out of git on purpose.

### 0.1 Listing inspector targets

`GET http://localhost:8081/json` and `GET /json/list` both return HTTP 200 with the same array. One entry per React Native page per attached device:

```json
{
  "id": "2610c661bf1bc785358b7d25898d16f209bc4889-1",
  "title": "com.mymeli.mobile (iPhone 17)",
  "description": "React Native Bridgeless [C++ connection]",
  "appId": "com.mymeli.mobile",
  "type": "node",
  "devtoolsFrontendUrl": "/debugger-frontend/rn_fusebox.html?ws=localhost%3A8081%2Finspector%2Fdebug%3Fdevice%3D2610c661…%26page%3D1&sources.hide_add_folder=true&unstable_enableNetworkPanel=true",
  "webSocketDebuggerUrl": "ws://localhost:8081/inspector/debug?device=2610c661bf1bc785358b7d25898d16f209bc4889&page=1",
  "deviceName": "iPhone 17",
  "reactNative": {
    "logicalDeviceId": "2610c661bf1bc785358b7d25898d16f209bc4889",
    "capabilities": { "supportsMultipleDebuggers": true, "nativeSourceCodeFetching": false, "nativePageReloads": true }
  }
}
```

Decisions:

- **Filter by `deviceName` equal to the booted simulator's name** (from `xcrun simctl list devices booted -j`). During the spike the list also contained the user's physical iPhone on the LAN (`deviceName: "iPhone"`, title `com.mymeli.mobile (iPhone)`), which answered every CDP call. The spike accidentally profiled and heap-snapshotted that phone once before the filter existed. The harness must never touch a target that is not the configured simulator.
- **The page number increments on every new React Native instance.** After a dev-client Metro switch the same device id reappeared as `…-2`. Always re-list after a switch or cold start and pick the highest page for the device.
- `/status` returns `packager-status:running` and is a cheap liveness check for Metro.

### 0.2 Opening the debugger socket

A plain WebSocket upgrade is refused. Two independent checks are in the way:

1. `@react-native/dev-middleware` (`InspectorProxy.js`, `verifyClient`) requires an `Origin` header whose hostname is `localhost` or `127.0.0.1`, or whose origin equals Metro's `serverBaseUrl`. No `Origin` → `HTTP/1.1 401 Unauthorized`.
2. `@expo/cli` (`createDebugMiddleware.js`) adds a second `connection` listener that calls `socket.terminate()` unless the socket is local and `Origin` host equals Expo's `serverBaseUrl` host. Expo reports that host as `127.0.0.1:8081` (the manifest's `debuggerHost`), even though `/json` prints `localhost`. `Origin: http://localhost:8081` therefore connects and is killed within one millisecond (close code 1006, no CDP reply ever arrives).

Observed matrix (`fixtures/phase0/probe-origin-matrix.mjs`):

| connect host | Origin | result |
|---|---|---|
| localhost or 127.0.0.1 | none | HTTP 401 |
| localhost or 127.0.0.1 | `http://localhost:8081` | open, then close 1006, no replies |
| localhost or 127.0.0.1 | `http://127.0.0.1:8081` | works |
| any | `http://192.168.0.100:8081` | HTTP 401 |

Decisions:

- Use the `ws` package (Node's built-in `WebSocket` cannot set headers).
- Derive the Origin from the Expo manifest (`GET /` with `expo-platform: ios` → `extra.expoGo.debuggerHost`, here `127.0.0.1:8081`), then fall back to trying `http://127.0.0.1:<port>` and `http://localhost:<port>` until a `Runtime.evaluate` of `1+1` round-trips. Treat "open but no reply within 2 s" as a rejected origin.
- `User-Agent` is irrelevant to both checks.

### 0.3 Scripts and the source map

`Runtime.enable` → `{}`. `Debugger.enable` → `{ "debuggerId": … }` followed by 30 `Debugger.scriptParsed` events within 1.5 s. Only three carry URLs that matter:

| scriptId | url | sourceMapURL |
|---|---|---|
| 6 | `http://localhost:8081/node_modules/expo-router/entry.bundle//&platform=ios&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.bytecode=1&transform.routerRoot=app&transform.reactCompiler=true&unstable_transformProfile=hermes-stable` | same path with `.map` and the same query |
| 29–31 | lazily loaded bundles such as `…/melements-components/TimelinePost/TimelinePostHeader/index.bundle//&…` | same path with `.map` |

The rest are native constructor stubs (`NativeRequest.__native_constructor__` and similar) with empty URLs. The main map is 59.6 MB, took 3.1 s to fetch, is Source Map v3 with 7,507 sources, 70,373 names and `x_facebook_sources` metadata.

Decisions:

- **Do not depend on the Debugger domain to find the map.** The map URL is the bundle URL with `.bundle` replaced by `.map` and the query kept, and bundle URLs appear in trace `ProfileChunk` frames, in `rnStackTrace` frames and in cpuprofile frames. With `lazy=true` every lazily loaded bundle has its own map; symbolication must key maps by bundle URL, not assume one map.
- Enable the Debugger domain only if a script list is explicitly needed, for a short window, and disable it before anything else. `Tracing.start` refuses to run while it is enabled (see 0.4), and a Hermes crash was observed on a page with debugger activity (see 0.9).

### 0.4 Tracing (primary source)

Verified against the native implementation in `react-native/ReactCommon/jsinspector-modern/TracingAgent.cpp` and `tracing/TracingCategory.h`, then exercised live.

Preconditions enforced by `TracingAgent.cpp`:

- Returns an error if more than one React Native host is registered in the process.
- Returns `"Debugger domain is expected to be disabled before starting Tracing"` if `Debugger.enable` is active on the session. Send `Debugger.disable` first.
- Returns `"Tracing has already been started"` if a recording is running.

Only `params.categories` (a comma-separated string) is read. Everything else the Chrome Performance panel sends (`options`, `transferMode`, `bufferUsageReportingInterval`, `traceConfig`) is ignored. Recognised category tokens, all others silently dropped:

| token | effect |
|---|---|
| `devtools.timeline` | `TimeStamp` events (React's `console.timeStamp` tracks), `TracingStartedInPage`, `ReactNative-TracingStopped` |
| `disabled-by-default-devtools.timeline` | hidden timeline events |
| `blink.user_timing` | `performance.mark` (`ph: "I"`) and `performance.measure` (`ph: "b"`/`"e"` pairs with the same `id`) |
| `disabled-by-default-v8.cpu_profiler` | **required for the sampling profiler**; produces one `Profile` event and `ProfileChunk` events |
| `v8.execute` | `RunTask` and `RunMicrotasks` event-loop events |
| `disabled-by-default-devtools.timeline.frame` | frame timing |
| `disabled-by-default-devtools.screenshot` | screenshots, not used |

Exact messages that worked:

```json
{"id":4,"method":"Debugger.disable","params":{}}
{"id":5,"method":"Tracing.start","params":{"categories":"-*,devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,v8.execute,disabled-by-default-v8.cpu_profiler,disabled-by-default-devtools.timeline.frame","options":"sampling-frequency=10000","transferMode":"ReportEvents"}}
… navigate, wait …
{"id":6,"method":"Tracing.end","params":{}}
```

`Tracing.end` returns `{}` and is followed by 24 `Tracing.dataCollected` notifications (`params.value` is an array of Chrome trace events) and one `Tracing.tracingComplete` with `{"dataLossOccurred":false}`. A three-second recording produced 275 events, of which 219 were `ProfileChunk` carrying 21,276 samples. Write `{ "traceEvents": [...] }` and the Chrome Performance panel loads it.

### 0.5 React 19.2 performance tracks: present, but not as user-timing measures

The build prompt expected user-timing measures with a `devtools` detail. In React 19.2.3 with React Native 0.85.3 the component and scheduler tracks arrive mostly as **`console.timeStamp` calls** that React Native converts into `TimeStamp` events in the `devtools.timeline` category. Observed in the first recording:

```json
{"name":"TimeStamp","cat":"devtools.timeline","ph":"I","ts":9481603752,"args":{"data":{
  "name":"ProfileShopMenuOption","message":"ProfileShopMenuOption",
  "start":9481603752,"end":9481603951,
  "track":"Components ⚛","color":"primary-light","rnStackTrace":null}}}
```

Tracks seen: `Components ⚛` (13 entries), and the `Scheduler ⚛` track group with tracks `Blocking`, `Transition`, `Suspense`, `Idle` (entries named `Render`, `Commit`, `Waiting for Paint`, `Remaining Effects`, plus one `<Track> Track` marker each when a recording starts). React Native also injects a synthetic `ReactNative-ComponentsTrack` entry at 4 µs so the Components track sorts first.

Colour semantics, read from `ReactFabric-dev.js` (`logComponentRender`, `logComponentEffect`):

| entry | colour | meaning |
|---|---|---|
| render | `primary-light` / `primary` / `primary-dark` / `error` | self time < 0.5 ms / < 10 ms / < 100 ms / ≥ 100 ms |
| effect | `secondary-light` / `secondary` / `secondary-dark` / `error` | self time < 1 ms / < 100 ms / < 500 ms / ≥ 500 ms |
| trigger (`Reconnect` and similar) | `warning` | emitted via `performance.measure` |

When a component's props object identity changed, React emits the render as a **`performance.measure`** named with a zero-width space prefix (`"​" + name`) and `detail.devtools.properties` holding the changed-props diff ("Changed props"), or a "deeply equal props" warning when the diff is deeply equal and the render was slow. In the trace those appear as `blink.user_timing` begin/end pairs with `args.detail` as a JSON string. This is the raw material for `wasted-render`.

Scheduler updates come with a cause. The `Update` measure's begin event carries both React's detail and a stack React Native captured at `setState` time:

```json
{"name":"Update","cat":"blink.user_timing","ph":"b","args":{
  "detail":"{\"devtools\":{\"color\":\"primary-light\",\"trackGroup\":\"Scheduler ⚛\",\"track\":\"Blocking\",\"properties\":[[\"Component name\",\"ProfileShopMenuOption\"],[\"Method name\",\"setState()\"]]}}",
  "data":{"rnStackTrace":{"description":"setState()","callFrames":[
    {"functionName":"startUpdateTimerByLane","url":"http://127.0.0.1:8081/node_modules/expo-router/entry.bundle//&…","lineNumber":68070,"columnNumber":41,"scriptId":"6"},
    {"functionName":"dispatchSetState","lineNumber":70054,"columnNumber":84,"…":"…"},
    {"functionName":"tick","lineNumber":821447,"columnNumber":24,"…":"…"}]}}}}
```

Symbolicated, `tick` is `app/(authenticated)/(modal)/user/store/hooks/use-shop-reset-countdown.ts:34`: a once-per-second countdown that re-renders `ProfileShopMenuOption` on every tab, including the home feed. First real finding, found by the spike without the analyzer.

Decision: **Tracing is the primary source.** The analyzer reads `TimeStamp` events (`args.data.track`, `trackGroup`, `color`, `start`, `end`, `name`), `blink.user_timing` measure pairs (`args.detail` parsed as JSON, `args.data.rnStackTrace`) and `ProfileChunk` samples. No fallback to the Profiler domain is needed for the waterfall.

### 0.6 Sampling profile inside the trace

`Profile` event: `{"ph":"P","id":"0x1","cat":"disabled-by-default-v8.cpu_profiler","args":{"data":{"startTime":…}}}` then `ProfileChunk` events with `args.data.cpuProfile.{nodes,samples}` and `args.data.timeDeltas`. Node shape:

```json
{"id":7,"parent":6,"callFrame":{"functionName":"","url":"http://127.0.0.1:8081/node_modules/expo-router/entry.bundle//&…","lineNumber":7729,"columnNumber":80,"scriptId":6,"codeType":"JS"}}
```

Line numbers are **1-based** (column 0-based). Verified with the `source-map` package (0.6.1) by resolving known frames: `dispatchSetState` at 70054:84 maps to `ReactFabric-dev.js:6950` only under the 1-based reading, and cpuprofile frames that have no mapping under the 0-based reading resolve cleanly under the 1-based one. Pass `{ line: lineNumber, column: columnNumber }` to `originalPositionFor` unchanged.

### 0.7 Profiler and HeapProfiler domains (secondary)

Hermes implements a subset. Verified on the simulator target:

| method | result |
|---|---|
| `Profiler.enable` | `-32601 Unsupported method` |
| `Profiler.setSamplingInterval` | `-32601 Unsupported method` |
| `Profiler.start` then `Profiler.stop` | works without `enable`; `.cpuprofile` with `nodes`, `samples`, `timeDeltas`, `startTime`, `endTime`; 2,501 nodes and 123 samples for a 1.5 s navigation |
| `HeapProfiler.enable` | `-32601 Unsupported method` |
| `HeapProfiler.takeHeapSnapshot {reportProgress:false}` | works without `enable`; snapshot arrives as `HeapProfiler.addHeapSnapshotChunk` notifications **before** the empty result; 1,966 chunks, 201 MB, 7.2 s, 1,419,672 nodes, 10,011,241 edges; V8 format with `node_fields` `["type","name","id","self_size","edge_count","trace_node_id","detachedness"]` |
| `HeapProfiler.collectGarbage` | works |
| `HeapProfiler.startSampling` / `stopSampling` | works, returns `{ head, samples }` |
| `Runtime.getHeapUsage` | works, `{ totalSize, usedSize }` |

Decisions: use `Profiler.start/stop` only for the light verification pass. Heap snapshots are expensive (hundreds of megabytes over the device socket) and must be opt-in per finding kind, with `collectGarbage` before each. They contain application strings, so they are never committed and never attached to a PR.

### 0.8 Runtime probes that work with zero app edits

`Runtime.evaluate` with `returnByValue: true` works on Fusebox. Verified expressions:

- `performance.rnStartupTiming` exists with `startTime`, `endTime`, `initializeRuntimeStart`, `executeJavaScriptBundleEntryPointStart` populated (`initializeRuntimeEnd` and `executeJavaScriptBundleEntryPointEnd` were undefined in this build).
- `performance.memory` reports `totalJSHeapSize` and `usedJSHeapSize` (`jsHeapSizeLimit` null). `HermesInternal.getRuntimeProperties()` identifies the engine and confirms `"Debugger Enabled": true`.
- `__REACT_DEVTOOLS_GLOBAL_HOOK__` is installed with `rendererInterfaces`, `renderers`, `onCommitFiberRoot` and friends, so React DevTools-style change descriptions are reachable in dev builds if ever needed.
- **Metro's module registry is reachable.** `__r.getModules()` returns a `Map` (7,502 entries) whose values carry `verboseName` (repo-relative path), `isInitialized` and `publicModule.exports`. This gives a stable, edit-free handle on any module.

Through that registry, Expo Router can be driven directly:

```js
// current route
store = modules.find(verboseName endsWith 'expo-router/build/global-state/router-store.js').publicModule.exports.store
store.getRouteInfo() // → { pathname: "/search", segments: ["(authenticated)","(tabs)","search"], params: {} }

// navigation
router = modules.find(verboseName endsWith 'expo-router/build/imperative-api.js').publicModule.exports.router
router.navigate('/notifications'); router.back(); router.canGoBack()
```

Verified live: `/search` → `navigate('/notifications')` → route info reported `/notifications` within 1.5 s → `back()` → `/search`. `fixtures/phase0/probe-router-navigate.mjs` is the exact script.

Decision: **scenario navigation uses the router API over CDP**, not custom-scheme deep links. Deep links (`mymeli://notifications`, `mymeli:///notifications`, `mymeli://--/notifications`, `mymeli://(authenticated)/(tabs)/notifications`) were all delivered to the app but none changed the route, because the reference app's own `hooks/deep-link/deep-link-context.tsx` subscribes to `Linking` `url` events and routes only the links it knows. That will be true of many real apps. Route verification after every step uses `store.getRouteInfo()`.

### 0.9 Dev-client deep link and cold start

Format confirmed from `expo-dev-launcher/ios/EXDevLauncherURLHelper.swift` and its tests: `<scheme>://expo-development-client/?url=<url-encoded Metro URL>`, for example `mymeli://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081`. Behaviour verified live:

- With the app dead, `xcrun simctl openurl booted <that URL>` cold-started the app and loaded the bundle from the given Metro; a new inspector page (`…-2`) appeared 5.5 s later.
- `EXDevLauncherController.onDeepLink` loads the app for dev-launcher URLs and, for every other URL, forwards it to the running app (`_handleExternalDeepLink` returns false when `isAppRunning`), or stores it as a pending deep link when the launcher is showing.

Hazard: **the reference app segfaults on JavaScript reload.** Crash report `Meli-2026-10-06-154202.ips`: `EXC_BAD_ACCESS` in `ScreenOrientationRegistry.registerController` (expo-screen-orientation) while Expo re-registers modules for a new React Native instance. A Metro-triggered full reload (another session saving files) killed the app at 15:40:46 IST. A second report, `Meli-2026-10-06-154654.ips`, shows a Hermes segfault in `Debugger::runUntilValidPauseLocation` → `CodeBlock::getSourceLocation` while an Expo event emitter delivered a `url` event; it coincided with one of the spike's deep links and with debugger activity on that page, cause not fully pinned down.

Decisions:

- Switching Metro servers for A/B is done by **terminate, then openurl with the dev-client URL** (`xcrun simctl terminate booted <bundleId>`, then the deep link). Never by in-process reload.
- The harness treats disappearance of the target from `/json`, or a changed app pid (`xcrun simctl spawn booted launchctl list`), as "app died" and cold-starts again.
- The harness never leaves the Debugger domain enabled while driving the app.

### 0.10 Environment hazards that invalidate measurements

- **The simulator is shared.** During the spike another Claude session working in the reference repo opened `mymeli://qa-first-journey-tmp`, ran `simctl terminate` plus `simctl launch` cycles, and its file saves triggered Metro reloads. `xcrun simctl spawn booted log show --predicate 'process == "CoreSimulatorBridge"'` shows every foreign `Opening URL` and `Requesting launch`. `fixpoint verify` should warn when such lines appear during a run, and A/B runs must be discarded if the app pid changes mid-pair.
- **Metro serves whatever branch the main checkout is on** (here a dirty feature branch with 21 modified files). A/B needs its own two worktrees and two Metro ports; the user's Metro is only for `scan`.
- A physical device attached to the same Metro shows up in `/json` and must be ignored (0.1).

### 0.11 Tooling available on this machine

Node 24.12.0, pnpm 11.1.2, gh 2.83.2 (logged in as iamxicor, ssh), ffmpeg 9.0.2, jq 1.7.1, Xcode at `/Applications/Xcode.app`. Missing: `idb`, `asciinema`, `agg`. Consequence: the standalone CLI gets scroll and tap only when `idb` is installed; in the Claude desktop app the iOS Simulator MCP tool provides them. Without either, scenarios are mount, navigate and back only, which the router API supports, and the report must say so.

### 0.12 Go / no-go

Go. Tracing with the React 19.2 tracks and the sampling profiler, symbolication through Metro's map, runtime probes, router-driven navigation and dev-client cold start all work with zero edits to the app. The remaining risks are environmental (shared simulator, reload crash, physical device on the same Metro) and are handled by target filtering, cold start and pid checks rather than by the measurement design.

---

## Phases 1–5 — packages, analyzer, harness, agent layer, init (2026-10-06)

### Monorepo

pnpm workspace, TypeScript project references (`tsc -b`), ESM with NodeNext resolution, vitest, ESLint 9 flat config with typescript-eslint, changesets with the five packages in one fixed group. `tsx` is only a dev convenience; published binaries run from `dist/`.

### devtools

- `pickTarget` filters by `deviceName` (the booted simulator's name) and, within a device, by the highest page number. Both rules come straight from Phase 0 (physical device on the same Metro; page id increments per RN instance).
- `DevToolsClient.connectTo` tries Origin candidates in order: Expo manifest `debuggerHost`, `127.0.0.1:<port>`, `localhost:<port>`, the Metro URL's own origin. A candidate counts as working only when a `Runtime.evaluate` of `1+1` round-trips within 3 s, because Expo terminates bad-origin sockets *after* the upgrade succeeds.
- `tracing.record` sends `Debugger.disable` before `Tracing.start` unconditionally.
- Symbolication passes Hermes line/column to `source-map` 0.6 unchanged (1-based line, 0-based column). React Compiler temporaries (`t0`…) are replaced by the map's `name` or, failing that, by the identifier declared at the original position (Metro maps include `sourcesContent`).
- Expo Router navigation and route probing go through `__r.getModules()` (a `Map` in Metro's dev runtime, entries carry `verboseName`); the module suffixes `expo-router/build/imperative-api.js` and `expo-router/build/global-state/router-store.js` are the only expo-router internals relied on.

### analyzer

- Commits are Scheduler ⚛ `Render` entries; a component entry belongs to the commit whose render window (extended to the end of `Remaining Effects`) contains it. The component tree is rebuilt by interval containment; self time = own span minus direct children.
- `wasted-render` counts only renders whose React-provided props diff is deeply equal, element-only, or callback-only (React's own "Referentially unequal function closure" note). Children-only diffs are reported but not counted; they mean the parent re-rendered.
- With no `RunTask` events (verified absent on RN 0.85), long tasks and frame drops are derived from sampling busy runs and the findings say so in `metric.method` and in `notes`.
- Findings on library components (CellRenderer, VirtualizedListCellContextProvider…) are located at the nearest app-owned ancestor in the commit tree; app ownership is known from Expo Router's `Name(./route.tsx)` naming or the harness's component index.
- Heap snapshots are aggregated by constructor from the raw JSON text, reading only `nodes` and `strings`, because a 230 MB snapshot's `edges` array is not needed for growth-by-constructor.
- Compiler bailouts are collected by running `babel-plugin-react-compiler` from the app's own `node_modules` with a `logger`, over the app's source, without touching its Babel config. Verified against the reference app's own `scripts/check-react-compiler.mjs`, which does the same.

### harness

- Scroll and tap default to a DevTools-driven implementation: the React DevTools hook exposes fiber roots, so the largest mounted vertical `ScrollView` instance can be found and `scrollTo` called with exact offsets, and a `testID`'s nearest `onPress` can be invoked. `idb` (real touches) is used when configured and installed. No app edits either way.
- Cold start = `simctl terminate` + `openurl` with the dev-client URL, then wait for a *new* inspector page (page number greater than before) and for the router store to report a route. The startup capture (`modulesInitialized`, `rnStartupTiming`) is taken at that moment.
- A/B pairs are A then B; the first pair is full tracing and discarded; measured pairs use `devtools.timeline,blink.user_timing` only. `renderMs` is Σ Render+Commit+Effects phase durations from scheduler entries, so it is available without the sampling profiler.
- Noise floor = 95th percentile of |relative A/A pair difference| of `renderMs`; threshold = `max(minEffect, noiseFloor)`. Exact Wilcoxon for n ≤ 20 (the usual 6 pairs) by enumerating sign assignments; bootstrap CI with a seeded PRNG so verdict files are reproducible.
- Control frames compare self time per symbolicated function in files outside `git diff --name-only base...candidate`; drift is the relative change of their total; three attempts, then `inconclusive`.
- The replay proxy keys on method + path + SHA-1(body) and in replay mode never calls `fetch`; the test suite asserts the upstream hit count does not move.
- Worktrees get `.env.development.local` copied (Phase 0 fact) and `node_modules` cloned with `cp -Rc` (APFS clonefile; falls back to a plain copy), so two Metro servers can run without a second install.
- `foreignDriverEvents` reads `CoreSimulatorBridge` log lines during a run and records them in the verdict, after Phase 0 showed another session driving the same simulator.

### Agent layer

- MCP tools map one-to-one onto harness entry points and return JSON; the long ones (`fixpoint_scan`, `fixpoint_ab`) keep a rolling log in the response.
- Skills carry the constraints the code cannot enforce: one recipe per PR, draft only, revert on anything but `accept`, the "dev build, iOS Simulator" label.
- `fixpoint.config.ts` is loaded with jiti and `fixpoint` is aliased to the harness's config module, so an app does not need Fixpoint installed to import `defineConfig`.

### init

`fixpoint init` never evaluates `app.config.ts` (it can import native modules and read secrets); it reads `app.json`, regex-scans `app.config.*` for `scheme` and `bundleIdentifier`, falls back to the Xcode project's `PRODUCT_BUNDLE_IDENTIFIER`, and finds the API base env var by scanning `.env*` and the config for `EXPO_PUBLIC_*API*URL*`. React Native < 0.81 is detected and reported as Profiler-only; v1 does not implement that fallback beyond detection because the React tracks (the primary source) need 19.2 anyway.

### Cold start must produce exactly one React Native host (2026-10-06, Phase 6)

`fixpoint verify` against the first real cold start failed with `Tracing.start: The Tracing domain is unavailable when multiple React Native hosts are registered.` Cause, from `expo-dev-launcher/ios/EXDevLauncherController.m`: when the app is launched **with** a URL (`simctl openurl` of the dev-client deep link), `UIApplicationLaunchOptionsURLKey` is set, so the launcher skips the "load last opened app" path, calls `navigateToLauncher` (creating one React host for the launcher), and then `onDeepLink` → `loadApp` creates the app host. Both stay registered; Metro lists the page as `…-2`. When launched **without** a URL and a "most recently opened app" exists in the registry, the launcher loads it directly as the only host (`…-1`).

The registry is plain UserDefaults in the app container: key `expo.devlauncher.recentlyopenedapps`, a dictionary keyed by URL with `{ url: string, timestamp: Int64 ms, isEASUpdate: bool, name?: string }` (`EXDevLauncherRecentlyOpenedAppsRegistry.swift`). It lives at `<simctl get_app_container … data>/Library/Preferences/<bundleId>.plist` and can be written while the app is terminated with `xcrun simctl spawn <udid> defaults write <plist> <key> '<dict>…</dict>'` (XML plist value keeps the integer type; a force-cast in the Swift reader would crash on a string timestamp).

Decision: `AppSession.coldStart` terminates the app, writes the registry so the target Metro is the most recent app, and plain-launches. Verified: page `-1`, `Tracing.start` works, 7,826 modules initialised at first-route-ready, ready in about 20 s on this machine. Fallback when the registry cannot be written: deep link (registers the URL) → terminate → plain launch. The deep link is never used for a measured instance.

### Scan robustness lessons from the first real run (2026-10-06, Phase 6)

- A scenario step that throws inside `tracing.record` used to leave the recording running; every later `Tracing.start` then failed with "Tracing has already been started". `record` now ends the trace in a `finally`.
- A screen without a vertical ScrollView is not an error; the scroll step is skipped and logged.
- The reference app has a root error boundary (`components/error-bondary/error-bondary.tsx`, `state.hasError`). Once it shows its fallback, the router store keeps reporting new pathnames while the screen stays "Something went wrong", and every route measures about 20 renders. The harness now checks for an active error boundary before each route and after each visit (fiber walk through the React DevTools hook: any class component whose state has a truthy `hasError`/`didCatch`, or `error` with `getDerivedStateFromError` on the class), discards the visit and cold-starts a fresh instance. Thirteen junk route results from the first attempt were deleted, not kept.
- `scan --resume` never attaches to whatever instance is running; it cold-starts. Attaching is only for `verify`.
- `/user/find-friends` and similar routes redirect away (permission or state gated); they are reported as "route did not reach" and stay in the index as failures.
