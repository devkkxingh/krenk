import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { OrchestrationEngine, type PersistedState } from '../orchestrator/engine.js';
import { ContextManager } from '../orchestrator/context.js';
import { TerminalRenderer } from '../ui/renderer.js';
import { THEME } from '../ui/theme.js';
import { arrowSelect } from '../ui/interactive.js';
import { loadConfig } from '../config/loader.js';
import { setupGracefulShutdown } from '../utils/process.js';
import { STAGES } from '../orchestrator/workflow.js';

/** All stage names in pipeline order (excluding 'complete') */
const STAGE_ORDER = STAGES.filter((s) => s.stage !== 'complete').map((s) => s.stage);

/** Map role file names to stage names */
const ROLE_TO_STAGE: Record<string, string> = {
  analyst: 'analyzing',
  strategist: 'planning',
  designer: 'designing',
  architect: 'architecting',
  builder: 'coding',
  qa: 'qa-planning',
  guardian: 'testing',
  sentinel: 'reviewing',
  security: 'securing',
  scribe: 'documenting',
  devops: 'deploying',
};

interface DiscoveredRun {
  runId: string;
  state: PersistedState | null;
  /** Stages inferred from <role>.md files (legacy runs without state.json) */
  inferredStages: string[];
  date: Date;
}

/**
 * Scan .krenk/history/ and discover all previous runs.
 */
async function discoverRuns(projectDir: string): Promise<DiscoveredRun[]> {
  const historyDir = path.join(projectDir, '.krenk', 'history');

  let entries: string[];
  try {
    entries = await fs.promises.readdir(historyDir);
  } catch {
    return [];
  }

  const runs: DiscoveredRun[] = [];

  for (const entry of entries) {
    const runDir = path.join(historyDir, entry);
    const stat = await fs.promises.stat(runDir).catch(() => null);
    if (!stat?.isDirectory()) continue;

    // Try to load state.json
    const state = (await ContextManager.loadRunState(projectDir, entry)) as PersistedState | null;

    // Infer completed stages from <role>.md files (for legacy runs)
    const inferredStages: string[] = [];
    try {
      const files = await fs.promises.readdir(runDir);
      for (const file of files) {
        if (file.endsWith('.md')) {
          const role = file.replace(/\.md$/, '');
          const stage = ROLE_TO_STAGE[role];
          if (stage) inferredStages.push(stage);
        }
      }
    } catch {
      // ignore
    }

    // Parse date from runId (ISO format with dashes replacing : and .)
    let date: Date;
    try {
      // runId format: 2026-02-17T10-30-00-000Z
      const isoStr = entry
        .replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1:$2:$3.$4Z');
      date = new Date(isoStr);
      if (isNaN(date.getTime())) date = new Date(stat.mtime);
    } catch {
      date = new Date(stat.mtime);
    }

    runs.push({ runId: entry, state, inferredStages, date });
  }

  // Sort newest first
  runs.sort((a, b) => b.date.getTime() - a.date.getTime());

  return runs;
}

/**
 * Get human-readable label for a run's furthest stage.
 */
function getStageLabel(completedStages: string[]): string {
  if (completedStages.length === 0) return 'not started';

  // Find the furthest stage reached
  let furthest = completedStages[0];
  for (const stage of completedStages) {
    if (STAGE_ORDER.indexOf(stage) > STAGE_ORDER.indexOf(furthest)) {
      furthest = stage;
    }
  }

  const info = STAGES.find((s) => s.stage === furthest);
  return info ? info.label : furthest;
}

/**
 * Get the list of completed stages — from state.json or inferred from files.
 */
function getCompletedStages(run: DiscoveredRun): string[] {
  if (run.state?.completedStages && run.state.completedStages.length > 0) {
    return run.state.completedStages;
  }
  return run.inferredStages;
}

/**
 * Format a run for display in the selection menu.
 */
function formatRunItem(run: DiscoveredRun): { label: string; description: string } {
  const dateStr = run.date.toLocaleString();
  const completed = getCompletedStages(run);
  const stageLabel = getStageLabel(completed);
  const status = run.state?.status || (completed.length > 0 ? 'interrupted' : 'unknown');

  const promptSnippet = run.state?.prompt
    ? run.state.prompt.slice(0, 50) + (run.state.prompt.length > 50 ? '...' : '')
    : '(no prompt saved)';

  const statusColor =
    status === 'complete' ? chalk.green :
    status === 'failed' ? chalk.red :
    chalk.yellow;

  return {
    label: dateStr,
    description: `${statusColor(status)} | reached: ${stageLabel} | ${chalk.dim(promptSnippet)}`,
  };
}

export async function resumeCommand(): Promise<void> {
  const cwd = process.cwd();

  console.log(chalk.bold.hex(THEME.primary)('\n  Resume a previous run\n'));

  const runs = await discoverRuns(cwd);

  if (runs.length === 0) {
    console.log(chalk.dim('  No previous runs found in .krenk/history/\n'));
    return;
  }

  // Filter out completed runs — can't resume those
  const resumable = runs.filter((r) => {
    const status = r.state?.status;
    return status !== 'complete';
  });

  if (resumable.length === 0) {
    console.log(chalk.dim('  All previous runs completed successfully. Nothing to resume.\n'));
    console.log(chalk.dim('  Recent runs:'));
    for (const run of runs.slice(0, 5)) {
      const item = formatRunItem(run);
      console.log(chalk.dim(`    ${item.label} — ${item.description}`));
    }
    console.log();
    return;
  }

  console.log(chalk.dim('  Select a run to resume:\n'));

  const menuItems = resumable.map(formatRunItem);
  const selectedIndex = await arrowSelect(menuItems);
  const selectedRun = resumable[selectedIndex];

  const completedStages = getCompletedStages(selectedRun);
  const prompt = selectedRun.state?.prompt;

  if (!prompt) {
    console.log(chalk.red('\n  Cannot resume: no prompt was saved for this run.'));
    console.log(chalk.dim('  This is a legacy run without state.json. Try running the task again.\n'));
    return;
  }

  // Show what will be skipped and what will run
  const skippedLabels = completedStages.map((s) => {
    const info = STAGES.find((st) => st.stage === s);
    return info?.label || s;
  });
  const remainingStages = STAGE_ORDER.filter((s) => !completedStages.includes(s));
  const remainingLabels = remainingStages.map((s) => {
    const info = STAGES.find((st) => st.stage === s);
    return info?.label || s;
  });

  console.log();
  if (skippedLabels.length > 0) {
    console.log(chalk.dim(`  Skipping completed: ${skippedLabels.join(', ')}`));
  }
  console.log(chalk.white(`  Resuming from: ${remainingLabels[0] || 'unknown'}`));
  console.log(chalk.dim(`  Remaining: ${remainingLabels.join(', ')}`));
  console.log();

  // Launch engine with resume options
  const config = await loadConfig(cwd);
  const skipStages = selectedRun.state?.skipStages || [];

  const engine = new OrchestrationEngine({
    cwd,
    maxParallel: config.maxParallelAgents,
    skipStages,
    noUi: false,
    supervised: false,
    agentConfig: config.agents,
    resumeRunId: selectedRun.runId,
    resumeCompletedStages: completedStages,
  });

  const renderer = new TerminalRenderer(engine);
  setupGracefulShutdown(engine, () => renderer.cleanup());

  const result = await engine.run(prompt);
  renderer.printSummary(result);

  if (!result.success) {
    process.exit(1);
  }
}
