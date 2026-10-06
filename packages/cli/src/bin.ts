#!/usr/bin/env node
import { createProgram } from './index.js';

createProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`fixpoint: ${message}\n`);
    if (process.env.FIXPOINT_DEBUG && err instanceof Error && err.stack) process.stderr.write(err.stack + '\n');
    process.exit(1);
  });
