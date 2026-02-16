import chalk from 'chalk';
import { OrchestrationEngine } from '../orchestrator/engine.js';
import { TerminalRenderer } from '../ui/renderer.js';
import { loadConfig } from '../config/loader.js';
import { setupGracefulShutdown, formatDuration } from '../utils/process.js';

interface RunOptions {
  skip?: string[];
  parallel?: string;
  ui?: boolean;
  supervised?: boolean;
}

export async function runCommand(
  prompt: string,
  options: RunOptions
): Promise<void> {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);

  const engine = new OrchestrationEngine({
    cwd,
    maxParallel: parseInt(options.parallel || String(config.maxParallelAgents), 10),
    skipStages: options.skip || config.skipStages,
    noUi: options.ui === false,
    supervised: options.supervised || false,
    agentConfig: config.agents,
  });

  if (options.ui !== false) {
    // Rich terminal UI with spinners, progress bars, and styled output
    const renderer = new TerminalRenderer(engine);

    setupGracefulShutdown(engine, () => renderer.cleanup());

    renderer.printBanner();
    renderer.printPrompt(prompt);

    const result = await engine.run(prompt);

    renderer.printSummary(result);

    if (!result.success) {
      process.exit(1);
    }
  } else {
    // Plain output mode (no fancy UI)
    setupGracefulShutdown(engine);
    printBannerPlain();
    console.log(chalk.dim(`Prompt: ${prompt}\n`));

    engine.on('stage', (stage: string) => {
      console.log(chalk.bold.cyan(`\n--- ${stage.toUpperCase()} ---\n`));
    });

    engine.on('agent:spawned', ({ role, pid }: { role: string; pid: number }) => {
      console.log(chalk.dim(`  Spawned ${role} (PID: ${pid})`));
    });

    engine.on('agent:done', ({ role, result }: { role: string; result: { success: boolean; duration: number } }) => {
      const status = result.success ? chalk.green('done') : chalk.red('failed');
      console.log(chalk.dim(`  ${role} ${status} (${result.duration}s)`));
    });

    const result = await engine.run(prompt);

    if (result.success) {
      console.log(
        chalk.green(
          `\n[done] Completed ${result.stages} stages in ${formatDuration(result.duration)}`
        )
      );
    } else {
      console.error(
        chalk.red(`\n[fail] Workflow failed after ${result.stages} stages`)
      );
      process.exit(1);
    }
  }
}

function printBannerPlain(): void {
  console.log(chalk.bold.cyan('\nKRENK'));
  console.log(chalk.gray('Multi-Agent Software Engineering Orchestrator'));
  console.log(chalk.gray('-'.repeat(55)));
}
