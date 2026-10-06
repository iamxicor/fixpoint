# Contributing

```bash
pnpm install
pnpm build        # tsc -b for all packages
pnpm test         # vitest, fixtures only, no simulator needed
pnpm lint
```

- The analyzer stays pure. A detector that needs the network or a simulator belongs in the harness.
- New finding kinds need a fixture under `fixtures/` and a test; synthetic fixtures are fine when the real thing is too large (heap snapshots) or contains application data.
- New fix recipes go in `docs/FIX-RECIPES.md` with *when*, *how*, *risk* and *evidence required*, and in the `FixId` union.
- Protocol facts verified against a real app go in `docs/DECISIONS.md` with the exact messages.
- Every published number must trace to a file in `docs/results/`.
- Conventional commits; a changeset for anything user-facing (`pnpm changeset`).

No telemetry, ever.
