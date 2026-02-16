import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { DEFAULT_CONFIG } from '../config/defaults.js';

export async function initCommand(): Promise<void> {
  const cwd = process.cwd();
  const krenkDir = path.join(cwd, '.krenk');
  const rcFile = path.join(cwd, '.krenkrc');

  console.log(chalk.bold.cyan('\n> Initializing Krenk...\n'));

  // Create .krenk directory
  if (!fs.existsSync(krenkDir)) {
    fs.mkdirSync(krenkDir, { recursive: true });
    console.log(chalk.green('  + Created .krenk/ directory'));
  } else {
    console.log(chalk.dim('  - .krenk/ directory already exists'));
  }

  // Create .krenk/history directory
  const historyDir = path.join(krenkDir, 'history');
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
    console.log(chalk.green('  + Created .krenk/history/ directory'));
  }

  // Create .krenkrc config file
  if (!fs.existsSync(rcFile)) {
    const config = {
      maxParallelAgents: DEFAULT_CONFIG.maxParallelAgents,
      claudePath: DEFAULT_CONFIG.claudePath,
      workflow: DEFAULT_CONFIG.workflow,
      skipStages: DEFAULT_CONFIG.skipStages,
      agents: {
        builder: { maxTurns: 100 },
        guardian: { maxTurns: 50 },
      },
    };
    fs.writeFileSync(rcFile, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    console.log(chalk.green('  + Created .krenkrc config file'));
  } else {
    console.log(chalk.dim('  - .krenkrc already exists'));
  }

  // Add .krenk to .gitignore if it exists
  const gitignore = path.join(cwd, '.gitignore');
  if (fs.existsSync(gitignore)) {
    const content = fs.readFileSync(gitignore, 'utf-8');
    if (!content.includes('.krenk')) {
      fs.appendFileSync(gitignore, '\n# Krenk orchestrator\n.krenk/\n');
      console.log(chalk.green('  + Added .krenk/ to .gitignore'));
    }
  }

  console.log(chalk.green('\n[done] Krenk initialized! Run `krenk run "your prompt"` to start.\n'));
}
