import { Command } from 'commander';
import { registerAnalyze } from './commands/analyze.js';

export function createProgram(): Command {
  const program = new Command();
  program
    .name('fixpoint')
    .description('Self-improving performance harness for React Native. Measure. Fix. Re-measure. Repeat until nothing changes.')
    .version('0.1.0')
    .showHelpAfterError();
  registerAnalyze(program);
  return program;
}
