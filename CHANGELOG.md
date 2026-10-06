# Changelog

All notable changes to Fixpoint are recorded here. The format follows Keep a Changelog and the project uses semantic versioning.

## [Unreleased]

### Added
- `@fixpoint/devtools`: typed CDP client for React Native DevTools through Metro (target filtering, Origin discovery, tracing, profiler, heap, runtime probes, Expo Router navigation through the module registry, source-map symbolication with React Compiler temporary stripping).
- `@fixpoint/analyzer`: pure trace → `findings.json` reduction with eight finding kinds, ranking, and `fixpoint analyze` table output; schema in `docs/FINDINGS-SCHEMA.md`.
- Phase 0 feasibility spike against the reference app (Expo SDK 56, React Native 0.85.3, React 19.2, Hermes). Findings, exact CDP messages and captured fixtures are in `docs/DECISIONS.md` and `fixtures/phase0/`.
