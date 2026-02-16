import chalk from 'chalk';
import { OrchestrationEngine } from '../orchestrator/engine.js';
import { loadConfig } from '../config/loader.js';
import { logger } from '../utils/logger.js';
import { setupGracefulShutdown, formatDuration } from '../utils/process.js';

export async function planCommand(prompt: string): Promise<void> {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);

  console.log(chalk.bold.cyan('\n> Planning: ') + prompt + '\n');

  const engine = new OrchestrationEngine({
    cwd,
    maxParallel: 1,
    skipStages: [],
    noUi: true,
    supervised: false,
    agentConfig: config.agents,
  });

  setupGracefulShutdown(engine);

  const result = await engine.runPlanOnly(prompt);

  if (result.success) {
    console.log(chalk.green('\n+ Plan created successfully'));
    console.log(chalk.dim(`Duration: ${result.duration}s`));
    console.log(chalk.dim(`Saved to: .krenk/strategist.md`));
    console.log(chalk.dim('\nRun `krenk build` to execute this plan.'));
  } else {
    console.error(chalk.red('\nx Planning failed'));
    if (result.output) {
      console.error(chalk.dim(result.output.substring(0, 500)));
    }
    process.exit(1);
  }
}
