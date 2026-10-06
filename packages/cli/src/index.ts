import { Command } from 'commander';
import { registerAnalyze } from './commands/analyze.js';
import { registerProject } from './commands/project.js';
import { registerRun } from './commands/run.js';

export { defineConfig } from '@fixpoint/harness';
export type { FixpointUserConfig, FixpointConfig } from '@fixpoint/harness';

export function createProgram(): Command {
  const program = new Command();
  program
    .name('fixpoint')
    .description('Self-improving performance harness for React Native. Measure. Fix. Re-measure. Repeat until nothing changes.')
    .version('0.1.0')
    .showHelpAfterError();
  registerProject(program);
  registerAnalyze(program);
  registerRun(program);
  return program;
}
