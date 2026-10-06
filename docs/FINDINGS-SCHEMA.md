# findings.json

The analyzer reduces every recording to one `findings.json`. The agent reasons over this file only; it never reads a raw trace. The file is produced by `fixpoint analyze` and by `fixpoint scan`, and consumed by the MCP server, the plugin skills and the PR template.

```ts
interface FindingsFile {
  version: 1;
  generatedAt: string;                       // ISO timestamp
  context: { route?: string; scenario?: string; platform: 'ios-simulator'; build: 'dev' };
  totals: {
    commits: number;                         // Scheduler ⚛ Render phases in the recording
    componentRenders: number;                // Components ⚛ render entries (effects excluded)
    wastedRenders: number;                   // renders whose props diff was deeply equal or callback-only
    jsBusyMs: number;                        // non-idle sampling time
    traceMs: number;
    samples: number;
  };
  findings: Finding[];                       // ranked, highest score first
  notes: string[];                           // caveats about the recording (missing event kinds, no symbolicator…)
}
```

## Finding

```ts
interface Finding {
  id: string;            // "<kind>:<slug>:<sha1-8>", stable across runs of the same code
  kind: FindingKind;
  severity: 'high' | 'medium' | 'low';
  score: number;         // rank score = severity weight × 100 + log10(metric) × 10 (+5 when deterministic)
  metric: Metric;        // the primary metric (see table below)
  evidence: {
    frames: FrameEvidence[];       // symbolicated hot frames, self time in ms, bundle position kept
    components: ComponentEvidence[]; // per-component render counts and props-diff classification
    commits: CommitEvidence[];     // commits involved: time, size, root, trigger
    extra?: Record<string, unknown>;
  };
  location: { file: string | null; line: number | null; column: number | null; symbol: string };
  suggestedFixes: FixId[];   // ids from docs/FIX-RECIPES.md
  summary: string;           // one plain-English paragraph
}

interface Metric {
  name: string;
  value: number;
  unit: 'count' | 'ms' | 'bytes' | 'percent';
  deterministic: boolean;    // true: compare exactly between A and B. false: needs a confidence interval
  method?: string;           // how the number was derived, printed next to it
  secondary?: Metric[];
}
```

## Kinds and primary metrics

| kind | primary metric | deterministic | derived from |
|---|---|---|---|
| `render-fanout` | `componentsPerCommit` (max over commits rooted at one component) | yes | `Components ⚛` entries inside one `Scheduler ⚛` Render phase; the root is the outermost entry by interval containment; `location` is the first app-owned component in the commit |
| `wasted-render` | `avoidableRenders` per component | yes | changed-props measures whose diff holds only deeply equal values, same-type elements, or functions React flagged as "referentially unequal function closure"; secondary `cascadingUpdates` counts `Cascading Update` measures |
| `hot-component` | `selfMsPerRender` | no (secondary `renders` is) | render span minus nested spans; frames from sampling data inside the render windows |
| `long-task` | `longestTaskMs` | no | `RunTask` events, or sampling-profiler busy runs with gaps under 2 ms when the event loop emits none |
| `frame-drop` | `framesOverBudget` in the scroll window | no | `BeginFrame`/`DrawFrame` pairs, or JS busy runs over 16.7 ms when frame events are absent |
| `startup-critical-path` | `modulesInitializedBeforeFirstScreen`, `routeModulesInitializedEagerly` | yes | Metro module registry at first-route-ready plus `performance.rnStartupTiming` |
| `heap-growth` | `retainedObjectsPerCycle` per constructor | yes | heap snapshot node counts by constructor after minus before, over N navigate-and-back cycles with a forced GC |
| `compiler-bailout` | `skippedFunctions` | yes | `babel-plugin-react-compiler` `CompileError` events from running the compiler over the app source; severity rises when the function also appears in a render finding |

## Severity thresholds (defaults, overridable through `thresholds` in `fixpoint.config.ts`)

| kind | low | medium | high |
|---|---|---|---|
| render-fanout (components per commit) | 15 | 40 | 100 |
| wasted-render (avoidable renders per scenario) | 5 | 15 | 50 |
| wasted-render (cascading updates) | 2 | 6 | 15 |
| hot-component (self ms per render) | 4 | 10 | 25 |
| long-task (longest ms) | 50 | 100 | 250 |
| frame-drop (percent of window frames over budget) | 2 % | 10 % | 25 % |
| startup-critical-path (modules) | 500 | 1500 | 3000 |
| heap-growth (bytes delta) | 50 KiB | 500 KiB | 5 MiB |

## Evidence shapes

```ts
interface FrameEvidence { symbol: string; file: string | null; line: number | null; column: number | null; selfMs: number; samples: number; generated?: { url: string; line: number; column: number } }
interface ComponentEvidence { name: string; renders: number; selfMs: number; wasted?: number; deepEqualRenders?: number; callbackOnlyRenders?: number; childrenOnlyRenders?: number; changedProps?: Record<string, number> }
interface CommitEvidence { index: number; atMs: number; renderMs: number; commitMs: number; components: number; root: string | null; trigger: string | null; track: string | null }
```

## Fix ids

`remove-compiler-bailout`, `stable-row-props`, `move-state-down`, `lazy-require`, `list-config`, `hoist-literals`, `remove-redundant-effect`, `subscription-cleanup`. Each is specified in [FIX-RECIPES.md](FIX-RECIPES.md).

## Guarantees

- The analyzer is a pure function of its inputs. Same recording, same findings (the test suite checks this).
- It never opens a network connection or talks to a simulator. Symbolication is injected by the caller.
- Every number carries `deterministic` and `method`. Time-based numbers are printed with `~` in tables and must only be compared through an interleaved A/B with a confidence interval.
- Every published number comes from a dev build on the iOS Simulator and is labelled as such.
