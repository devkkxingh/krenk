#!/usr/bin/env node
import { program } from 'commander';
import { runCommand } from './commands/run.js';
import { planCommand } from './commands/plan.js';
import { buildCommand } from './commands/build.js';
import { testCommand } from './commands/test.js';
import { reviewCommand } from './commands/review.js';
import { initCommand } from './commands/init.js';
import { statusCommand } from './commands/status.js';
import { startInteractiveSession } from './ui/interactive.js';

program
  .name('krenk')
  .description(
    'Multi-agent software engineering orchestrator powered by Claude Code'
  )
  .version('0.1.0')
  .action(async () => {
    // No subcommand provided — launch interactive session
    await startInteractiveSession();
  });

program
  .command('run')
  .description('Run full engineering workflow with all agents')
  .argument('<prompt>', 'What to build')
  .option('--skip <stages...>', 'Skip specific stages (e.g. --skip design test)')
  .option('--parallel <n>', 'Max parallel agents', '3')
  .option('--no-ui', 'Disable fancy UI, use plain output')
  .option('--supervised', 'Approve each agent before it runs')
  .action(runCommand);

program
  .command('plan')
  .description('Run only the planning stage')
  .argument('<prompt>', 'What to plan')
  .action(planCommand);

program
  .command('build')
  .description('Execute from an existing plan in .krenk/strategist.md')
  .action(buildCommand);

program
  .command('test')
  .description('Generate and run tests for the current project')
  .action(testCommand);

program
  .command('review')
  .description('Run code review on the current project')
  .action(reviewCommand);

program
  .command('init')
  .description('Initialize Krenk in the current directory')
  .action(initCommand);

program
  .command('status')
  .description('Show the current Krenk state and last run info')
  .action(statusCommand);

program.parse();
