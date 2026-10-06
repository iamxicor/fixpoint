/**
 * Shared protocol types for talking to React Native DevTools through Metro's inspector proxy.
 * Everything here was verified against Expo SDK 56 / React Native 0.85.3 / Hermes (see docs/DECISIONS.md §0).
 */

/** One entry of `GET <metro>/json`. */
export interface InspectorTarget {
  id: string;
  title: string;
  description: string;
  appId?: string;
  type: string;
  devtoolsFrontendUrl?: string;
  webSocketDebuggerUrl: string;
  deviceName?: string;
  reactNative?: {
    logicalDeviceId?: string;
    capabilities?: {
      supportsMultipleDebuggers?: boolean;
      nativeSourceCodeFetching?: boolean;
      nativePageReloads?: boolean;
    };
  };
}

/** Chrome trace event as emitted by React Native's `Tracing.dataCollected`. */
export interface TraceEvent {
  name: string;
  cat: string;
  ph: string;
  ts: number;
  pid?: number;
  tid?: number;
  dur?: number;
  id?: string | number;
  args?: any;
  s?: string;
}

export interface TraceFile {
  traceEvents: TraceEvent[];
  metadata?: Record<string, unknown>;
}

/** CDP `Profiler.stop` result (`.cpuprofile`). */
export interface CpuProfileNode {
  id: number;
  callFrame: CallFrame;
  hitCount?: number;
  children?: number[];
  parent?: number;
  positionTicks?: { line: number; ticks: number }[];
}

export interface CallFrame {
  functionName: string;
  scriptId: string | number;
  url: string;
  /** 1-based in Hermes output (verified by symbolicating known frames). */
  lineNumber: number;
  /** 0-based. */
  columnNumber: number;
  codeType?: string;
}

export interface CpuProfile {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

/** V8 heap snapshot format as produced by Hermes. */
export interface HeapSnapshot {
  snapshot: {
    meta: {
      node_fields: string[];
      node_types: (string | string[])[];
      edge_fields: string[];
      edge_types: (string | string[])[];
      [k: string]: unknown;
    };
    node_count: number;
    edge_count: number;
    trace_function_count?: number;
  };
  nodes: number[];
  edges: number[];
  strings: string[];
  [k: string]: unknown;
}

export interface ScriptInfo {
  scriptId: string;
  url: string;
  sourceMapURL?: string;
}

export interface StartupTiming {
  startTime?: number;
  endTime?: number;
  initializeRuntimeStart?: number;
  initializeRuntimeEnd?: number;
  executeJavaScriptBundleEntryPointStart?: number;
  executeJavaScriptBundleEntryPointEnd?: number;
}

export interface RouteInfo {
  pathname: string;
  segments: string[];
  params: Record<string, unknown>;
  pathnameWithParams?: string;
}

export interface SymbolicatedFrame {
  functionName: string;
  /** Original identifier after React Compiler temporaries (`t0`, `t5`) are mapped back where possible. */
  symbol: string;
  file: string | null;
  line: number | null;
  column: number | null;
  /** The generated (bundle) position this frame came from. */
  generated: { url: string; line: number; column: number };
}
