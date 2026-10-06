import type { CallFrame, CpuProfile, HeapSnapshot, StartupTiming, SymbolicatedFrame, TraceFile } from '@fixpoint/devtools';

export type FindingKind =
  | 'render-fanout'
  | 'wasted-render'
  | 'hot-component'
  | 'long-task'
  | 'frame-drop'
  | 'startup-critical-path'
  | 'heap-growth'
  | 'compiler-bailout';

export type Severity = 'high' | 'medium' | 'low';

/** Ids of the fix allow-list, documented in docs/FIX-RECIPES.md. */
export type FixId =
  | 'remove-compiler-bailout'
  | 'stable-row-props'
  | 'move-state-down'
  | 'lazy-require'
  | 'list-config'
  | 'hoist-literals'
  | 'remove-redundant-effect'
  | 'subscription-cleanup';

export type MetricUnit = 'count' | 'ms' | 'bytes' | 'percent';

export interface Metric {
  name: string;
  value: number;
  unit: MetricUnit;
  /** True when two runs of the same scenario on the same code must produce the same value. */
  deterministic: boolean;
  /** How the value was derived; printed next to every number. */
  method?: string;
  secondary?: Metric[];
}

export interface Location {
  file: string | null;
  line: number | null;
  column: number | null;
  symbol: string;
}

export interface FrameEvidence {
  symbol: string;
  file: string | null;
  line: number | null;
  column: number | null;
  selfMs: number;
  samples: number;
  /** Generated position, kept so a reviewer can re-symbolicate. */
  generated?: { url: string; line: number; column: number };
}

export interface ComponentEvidence {
  name: string;
  renders: number;
  selfMs: number;
  wasted?: number;
  deepEqualRenders?: number;
  callbackOnlyRenders?: number;
  childrenOnlyRenders?: number;
  /** Prop keys React reported as changed, with how often. */
  changedProps?: Record<string, number>;
}

export interface CommitEvidence {
  index: number;
  /** Milliseconds from the start of the trace. */
  atMs: number;
  renderMs: number;
  commitMs: number;
  components: number;
  root: string | null;
  trigger: string | null;
  track: string | null;
}

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: Severity;
  /** Rank score; higher sorts first. */
  score: number;
  metric: Metric;
  evidence: {
    frames: FrameEvidence[];
    components: ComponentEvidence[];
    commits: CommitEvidence[];
    extra?: Record<string, unknown>;
  };
  location: Location;
  suggestedFixes: FixId[];
  summary: string;
}

export interface ScenarioWindow {
  label: string;
  /** Milliseconds relative to the trace start. */
  startMs: number;
  endMs: number;
}

export interface StartupCapture {
  /** Repo-relative module paths that were initialised when the first route became ready. */
  modulesInitialized: string[];
  rnStartupTiming?: StartupTiming | null;
  firstRoute?: string;
  /** Route file (repo-relative) rendered first, when known. */
  firstRouteModule?: string;
}

export interface HeapCapture {
  before: HeapSnapshot | string;
  after: HeapSnapshot | string;
  /** Number of navigate-and-back cycles performed between the snapshots. */
  cycles: number;
}

export interface CompilerBailout {
  file: string;
  line: number | null;
  column: number | null;
  /** Component or hook name the compiler skipped. */
  fn: string | null;
  reason: string;
  detail?: string | null;
}

export interface AnalyzeInput {
  trace?: TraceFile;
  profile?: CpuProfile;
  heap?: HeapCapture;
  startup?: StartupCapture;
  compiler?: { bailouts: CompilerBailout[] };
  /** Scenario windows (for example the scroll phase) relative to trace start. Derived from trace metadata marks when omitted. */
  windows?: ScenarioWindow[];
  /** Optional offline symbolicator; the analyzer never fetches anything itself. */
  symbolicate?: (frames: CallFrame[]) => Promise<SymbolicatedFrame[]>;
  /** Component name → source location, built by the harness from the app source. */
  componentLocations?: Record<string, Location>;
  /** App root, used to recognise app code versus node_modules in symbolicated paths. */
  appRoot?: string;
  context?: { route?: string; scenario?: string; platform?: string; build?: string };
  thresholds?: Partial<Thresholds>;
}

export interface Thresholds {
  longTaskMs: number;
  frameBudgetMs: number;
  fanoutLow: number;
  fanoutMedium: number;
  fanoutHigh: number;
  wastedLow: number;
  wastedMedium: number;
  wastedHigh: number;
  hotSelfMsLow: number;
  hotSelfMsMedium: number;
  hotSelfMsHigh: number;
  heapGrowthMinObjects: number;
  busyRunGapMs: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  longTaskMs: 50,
  frameBudgetMs: 16.7,
  fanoutLow: 15,
  fanoutMedium: 40,
  fanoutHigh: 100,
  wastedLow: 5,
  wastedMedium: 15,
  wastedHigh: 50,
  hotSelfMsLow: 4,
  hotSelfMsMedium: 10,
  hotSelfMsHigh: 25,
  heapGrowthMinObjects: 10,
  busyRunGapMs: 2,
};

export interface FindingsFile {
  version: 1;
  generatedAt: string;
  context: { route?: string; scenario?: string; platform: string; build: string };
  totals: {
    commits: number;
    componentRenders: number;
    wastedRenders: number;
    jsBusyMs: number;
    traceMs: number;
    samples: number;
  };
  findings: Finding[];
  notes: string[];
}
