import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { OrchestrationEngine } from '../orchestrator/engine.js';
import { loadConfig } from '../config/loader.js';
import { setupGracefulShutdown, formatDuration } from '../utils/process.js';

export async function buildCommand(): Promise<void> {
  const cwd = process.cwd();
  const planFile = path.join(cwd, '.krenk', 'strategist.md');

  if (!fs.existsSync(planFile)) {
    console.error(
      chalk.red(
        'No plan found. Run `krenk plan "your prompt"` first, or use `krenk run "prompt"` for the full pipeline.'
      )
    );
    process.exit(1);
  }

  const plan = fs.readFileSync(planFile, 'utf-8');
  console.log(chalk.bold.cyan('\n# Building from existing plan...\n'));
  console.log(chalk.dim(plan.substring(0, 200) + '...\n'));

  const config = await loadConfig(cwd);

  const engine = new OrchestrationEngine({
    cwd,
    maxParallel: config.maxParallelAgents,
    skipStages: ['planning'], // Skip planning since we have the plan
    noUi: true,
    supervised: false,
    agentConfig: config.agents,
  });

  setupGracefulShutdown(engine);

  // Inject the existing plan into context
  const result = await engine.run(
    `Execute the following plan:\n\n${plan}`
  );

  if (result.success) {
    console.log(
      chalk.green(
        `\n+ Build completed in ${formatDuration(result.duration)}`
      )
    );
  } else {
    console.error(chalk.red('\nx Build failed'));
    process.exit(1);
  }
}
