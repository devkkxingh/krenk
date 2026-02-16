import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { ROLES } from '../agents/roles.js';

export async function statusCommand(): Promise<void> {
  const cwd = process.cwd();
  const krenkDir = path.join(cwd, '.krenk');

  if (!fs.existsSync(krenkDir)) {
    console.log(
      chalk.yellow(
        '\nNo .krenk/ directory found. Run `krenk init` or `krenk run "prompt"` first.\n'
      )
    );
    return;
  }

  console.log(chalk.bold.cyan('\n> Krenk Status\n'));

  // Check for state file
  const stateFile = path.join(krenkDir, 'state.json');
  if (fs.existsSync(stateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      console.log(chalk.white('  Last run:'));
      console.log(chalk.dim(`    Stage: ${state.stage || 'unknown'}`));
      console.log(chalk.dim(`    Stages completed: ${state.stageCount || 0}`));
      if (state.duration) {
        console.log(chalk.dim(`    Duration: ${state.duration}s`));
      }
      if (state.runId) {
        console.log(chalk.dim(`    Run ID: ${state.runId}`));
      }
      console.log();
    } catch {
      console.log(chalk.dim('  Could not parse state.json\n'));
    }
  }

  // Check for agent outputs
  console.log(chalk.white('  Agent outputs:'));
  const roleKeys = Object.keys(ROLES);
  let hasOutputs = false;

  for (const key of roleKeys) {
    const file = path.join(krenkDir, `${key}.md`);
    if (fs.existsSync(file)) {
      const stat = fs.statSync(file);
      const size = formatSize(stat.size);
      const modified = stat.mtime.toLocaleString();
      const role = ROLES[key];
      console.log(
        chalk.dim(`    ${role.emoji} ${role.name.padEnd(12)} ${size.padEnd(8)} ${modified}`)
      );
      hasOutputs = true;
    }
  }

  if (!hasOutputs) {
    console.log(chalk.dim('    No agent outputs found'));
  }

  // Check history
  const historyDir = path.join(krenkDir, 'history');
  if (fs.existsSync(historyDir)) {
    const runs = fs.readdirSync(historyDir).filter((d) => {
      return fs.statSync(path.join(historyDir, d)).isDirectory();
    });
    if (runs.length > 0) {
      console.log(chalk.white(`\n  History: ${runs.length} previous run(s)`));
      for (const run of runs.slice(-5)) {
        console.log(chalk.dim(`    ${run}`));
      }
    }
  }

  console.log();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
