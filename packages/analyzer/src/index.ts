export * from './types.js';
export { analyze, rank } from './analyze.js';
export { buildModel, windowsFromMetadata, COMPONENTS_TRACK, SCHEDULER_GROUP, type TraceModel, type Commit, type ComponentRender, type UpdateEvent } from './trace/model.js';
export { parsePropsDiff, type PropsDiff, type PropChange, type PropChangeKind } from './trace/props-diff.js';
export { samplesFromTrace, samplesFromProfile, busyRuns, busyUs, selfTimeByFrame, stackOf, type SampleTimeline, type BusyRun } from './trace/profile.js';
export { aggregateSnapshot, aggregateFromText, diffAggregates, type HeapAggregate, type HeapGrowthRow } from './heap/parse.js';
export { renderTable, renderMarkdown, formatMetric, formatLocation } from './report.js';
export { findingId, routeFileFromName, displayName } from './detectors/context.js';
