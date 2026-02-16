import chalk from 'chalk';
import { runAgent } from '../agents/spawner.js';
import { ROLES } from '../agents/roles.js';
import { loadConfig } from '../config/loader.js';
import { formatDuration } from '../utils/process.js';

export async function testCommand(): Promise<void> {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const role = ROLES.guardian;

  console.log(
    chalk.bold.cyan(
      `\n${role.emoji} ${role.name} - Generating and running tests...\n`
    )
  );

  const result = await runAgent({
    role: 'guardian',
    prompt:
      'Analyze this project, write comprehensive tests (unit + integration), and run them. Report results with PASS/FAIL status.',
    systemPrompt: role.systemPrompt,
    cwd,
    maxTurns: config.agents.guardian?.maxTurns || 50,
    allowedTools: role.allowedTools,
  });

  if (result.success) {
    console.log(chalk.green(`\n+ Testing completed in ${formatDuration(result.duration)}`));
    console.log(chalk.dim('\nTest output:'));
    console.log(result.output.substring(0, 2000));
  } else {
    console.error(chalk.red(`\nx Testing failed after ${result.duration}s`));
    if (result.output) {
      console.error(chalk.dim(result.output.substring(0, 1000)));
    }
    process.exit(1);
  }
}
