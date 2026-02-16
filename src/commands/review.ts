import chalk from 'chalk';
import { runAgent } from '../agents/spawner.js';
import { ROLES } from '../agents/roles.js';
import { loadConfig } from '../config/loader.js';
import { formatDuration } from '../utils/process.js';

export async function reviewCommand(): Promise<void> {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const role = ROLES.sentinel;

  console.log(
    chalk.bold.cyan(
      `\n${role.emoji} ${role.name} - Reviewing code quality...\n`
    )
  );

  const result = await runAgent({
    role: 'sentinel',
    prompt:
      'Review all code in this project for bugs, security issues, performance problems, and style inconsistencies. Output a structured review with severity levels.',
    systemPrompt: role.systemPrompt,
    cwd,
    maxTurns: config.agents.sentinel?.maxTurns || 30,
    allowedTools: role.allowedTools,
  });

  if (result.success) {
    console.log(chalk.green(`\n+ Review completed in ${formatDuration(result.duration)}`));
    console.log(chalk.dim('\nReview output:'));
    console.log(result.output.substring(0, 3000));
  } else {
    console.error(chalk.red(`\nx Review failed after ${result.duration}s`));
    if (result.output) {
      console.error(chalk.dim(result.output.substring(0, 1000)));
    }
    process.exit(1);
  }
}
