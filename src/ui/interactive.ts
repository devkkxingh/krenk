import * as readline from 'node:readline';
import { spawn as spawnProcess } from 'node:child_process';
import chalk from 'chalk';
import gradient from 'gradient-string';
import figlet from 'figlet';
import boxen from 'boxen';
import ora from 'ora';
import { OrchestrationEngine } from '../orchestrator/engine.js';
import { TerminalRenderer } from './renderer.js';
import { THEME } from './theme.js';
import { ROLES } from '../agents/roles.js';
import { loadConfig } from '../config/loader.js';
import { setupGracefulShutdown } from '../utils/process.js';

interface TeamPreset {
  label: string;
  description: string;
  roles: string[];
  skipStages: string[];
}

const TEAM_PRESETS: TeamPreset[] = [
  {
    label: 'Full Team',
    description: 'All 11 agents - BA, plan, design, arch, code, QA, test, review, security, docs, devops',
    roles: ['analyst', 'strategist', 'designer', 'architect', 'builder', 'qa', 'guardian', 'sentinel', 'security', 'scribe', 'devops'],
    skipStages: [],
  },
  {
    label: 'Engineering',
    description: 'Plan, architect, code, test, review',
    roles: ['strategist', 'architect', 'builder', 'guardian', 'sentinel'],
    skipStages: ['analyzing', 'designing', 'qa-planning', 'securing', 'documenting', 'deploying'],
  },
  {
    label: 'QA Focused',
    description: 'BA, plan, code, QA, test, review -- quality first',
    roles: ['analyst', 'strategist', 'builder', 'qa', 'guardian', 'sentinel'],
    skipStages: ['designing', 'architecting', 'securing', 'documenting', 'deploying'],
  },
  {
    label: 'Startup MVP',
    description: 'BA, plan, architect, code, review, docs -- ship fast',
    roles: ['analyst', 'strategist', 'architect', 'builder', 'sentinel', 'scribe'],
    skipStages: ['designing', 'qa-planning', 'testing', 'securing', 'deploying'],
  },
  {
    label: 'Enterprise',
    description: 'BA, plan, design, arch, code, QA, test, security, review, docs, devops',
    roles: ['analyst', 'strategist', 'designer', 'architect', 'builder', 'qa', 'guardian', 'sentinel', 'security', 'scribe', 'devops'],
    skipStages: [],
  },
  {
    label: 'Quick Build',
    description: 'Plan and code only -- fastest path',
    roles: ['strategist', 'builder'],
    skipStages: ['analyzing', 'designing', 'architecting', 'qa-planning', 'testing', 'reviewing', 'securing', 'documenting', 'deploying'],
  },
  {
    label: 'Custom',
    description: 'Pick your agents',
    roles: [],
    skipStages: [],
  },
];

const ALL_AGENTS = [
  { key: 'analyst', label: 'Analyst (BA)', desc: 'Business analysis & user stories' },
  { key: 'strategist', label: 'Strategist', desc: 'Requirements & planning' },
  { key: 'designer', label: 'Pixel', desc: 'UI/UX design' },
  { key: 'architect', label: 'Blueprint', desc: 'System architecture' },
  { key: 'builder', label: 'Builder', desc: 'Code implementation' },
  { key: 'qa', label: 'QA Lead', desc: 'Test strategy & test plans' },
  { key: 'guardian', label: 'Guardian', desc: 'Test execution' },
  { key: 'sentinel', label: 'Sentinel', desc: 'Code review' },
  { key: 'security', label: 'Shield', desc: 'Security audit' },
  { key: 'scribe', label: 'Scribe', desc: 'Documentation' },
  { key: 'devops', label: 'DevOps', desc: 'CI/CD & deployment' },
];

// ── Arrow-key menu ─────────────────────────────────────────

/** Track how many terminal lines the last render actually used */
let lastRenderedLines = 0;

function renderMenu(
  items: { label: string; description: string }[],
  selected: number,
  multi?: boolean,
  checked?: Set<number>,
): void {
  const cols = process.stdout.columns || 80;
  lastRenderedLines = 0;

  for (let i = 0; i < items.length; i++) {
    const isSelected = i === selected;
    const pointer = isSelected ? chalk.hex(THEME.primary)('>') : ' ';
    const label = isSelected
      ? chalk.bold.white(items[i].label.padEnd(14))
      : chalk.white(items[i].label.padEnd(14));

    // Truncate description to prevent line wrapping
    const prefix = multi ? '    X [x]  ' : '    X '; // measure raw prefix width
    const labelRaw = items[i].label.padEnd(14);
    const availableForDesc = cols - prefix.length - labelRaw.length - 2;
    const descText = availableForDesc > 10
      ? items[i].description.slice(0, availableForDesc)
      : items[i].description.slice(0, 30);
    const desc = chalk.dim(descText);

    let check = '';
    if (multi && checked) {
      check = checked.has(i)
        ? chalk.hex(THEME.primary)(' [x] ')
        : chalk.dim(' [ ] ');
    }

    process.stdout.write(`    ${pointer}${check} ${label} ${desc}\n`);
    lastRenderedLines++;
  }
}

function clearMenu(count?: number): void {
  const lines = count ?? lastRenderedLines;
  // Move up and clear each line, then clear everything below
  for (let i = 0; i < lines; i++) {
    process.stdout.write('\x1b[1A');
  }
  process.stdout.write('\x1b[0J');
}

/**
 * Single-select arrow-key menu. Returns the chosen index.
 */
export function arrowSelect(
  items: { label: string; description: string }[],
): Promise<number> {
  return new Promise((resolve) => {
    let selected = 0;
    renderMenu(items, selected);

    const wasRaw = process.stdin.isRaw;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    const onKey = (key: Buffer) => {
      const str = key.toString();

      // Ctrl+C
      if (str === '\x03') {
        if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false);
        process.stdin.pause();
        process.stdin.removeListener('data', onKey);
        process.exit(0);
      }

      // Up arrow
      if (str === '\x1b[A' && selected > 0) {
        selected--;
        clearMenu();
        renderMenu(items, selected);
      }

      // Down arrow
      if (str === '\x1b[B' && selected < items.length - 1) {
        selected++;
        clearMenu();
        renderMenu(items, selected);
      }

      // Enter
      if (str === '\r' || str === '\n') {
        if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false);
        process.stdin.pause();
        process.stdin.removeListener('data', onKey);
        clearMenu();
        // Re-render with final selection highlighted
        const item = items[selected];
        console.log(`    ${chalk.hex(THEME.primary)('>')} ${chalk.bold.white(item.label)}`);
        resolve(selected);
      }
    };

    process.stdin.on('data', onKey);
  });
}

/**
 * Multi-select arrow-key menu. Space to toggle, Enter to confirm.
 * Returns array of selected indices.
 */
function arrowMultiSelect(
  items: { label: string; description: string }[],
): Promise<number[]> {
  return new Promise((resolve) => {
    let selected = 0;
    const checked = new Set<number>();
    renderMenu(items, selected, true, checked);

    const wasRaw = process.stdin.isRaw;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    const onKey = (key: Buffer) => {
      const str = key.toString();

      if (str === '\x03') {
        if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false);
        process.stdin.pause();
        process.stdin.removeListener('data', onKey);
        process.exit(0);
      }

      if (str === '\x1b[A' && selected > 0) {
        selected--;
        clearMenu();
        renderMenu(items, selected, true, checked);
      }

      if (str === '\x1b[B' && selected < items.length - 1) {
        selected++;
        clearMenu();
        renderMenu(items, selected, true, checked);
      }

      // Space to toggle
      if (str === ' ') {
        if (checked.has(selected)) {
          checked.delete(selected);
        } else {
          checked.add(selected);
        }
        clearMenu();
        renderMenu(items, selected, true, checked);
      }

      // Enter to confirm
      if (str === '\r' || str === '\n') {
        if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false);
        process.stdin.pause();
        process.stdin.removeListener('data', onKey);
        clearMenu();
        // Show final selections
        const picks = Array.from(checked).sort();
        if (picks.length > 0) {
          const names = picks.map((i) => items[i].label).join(', ');
          console.log(`    ${chalk.hex(THEME.primary)('>')} ${chalk.bold.white(names)}`);
        }
        resolve(picks);
      }
    };

    process.stdin.on('data', onKey);
  });
}

// ── Helpers ─────────────────────────────────────────────────

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function printBanner(): void {
  // Top spacing
  console.log('\n\n');

  const ascii = figlet.textSync('KRENK', { font: 'ANSI Shadow' });
  console.log(gradient(THEME.gradient)(ascii));
  console.log(chalk.dim('  like claude code, but with a team'));
  console.log(chalk.dim('  ' + '-'.repeat(50)));

  console.log(chalk.dim('  built by Krishna with mass amount of \u{2615}'));
  console.log();
}

function resolveSkipStages(selectedRoles: string[]): string[] {
  const roleToStage: Record<string, string> = {
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

  const skip: string[] = [];
  for (const [role, stage] of Object.entries(roleToStage)) {
    if (!selectedRoles.includes(role)) {
      skip.push(stage);
    }
  }
  return skip;
}

function detectFollowUps(task: string): { question: string; key: string }[] {
  const lower = task.toLowerCase();
  const followUps: { question: string; key: string }[] = [];

  const webKeywords = ['web', 'frontend', 'ui', 'website', 'dashboard', 'app', 'page', 'component', 'react', 'vue', 'svelte', 'next'];
  const backendKeywords = ['backend', 'api', 'server', 'rest', 'graphql', 'endpoint', 'microservice'];
  const dbKeywords = ['database', 'db', 'data', 'store', 'crud', 'model', 'schema', 'postgres', 'mongo', 'sql'];

  if (webKeywords.some((kw) => lower.includes(kw))) {
    followUps.push({
      question: 'What framework? (react/vue/svelte/skip) ',
      key: 'framework',
    });
  }

  if (backendKeywords.some((kw) => lower.includes(kw))) {
    followUps.push({
      question: 'What runtime? (node/python/go/skip) ',
      key: 'runtime',
    });
  }

  if (dbKeywords.some((kw) => lower.includes(kw))) {
    followUps.push({
      question: 'What database? (postgres/mongo/sqlite/skip) ',
      key: 'database',
    });
  }

  if (followUps.length === 0) {
    followUps.push({
      question: 'Any tech stack or constraints? (press enter to skip) ',
      key: 'constraints',
    });
  }

  return followUps.slice(0, 2);
}

// ── Prompt Refinement via Claude ─────────────────────────────

interface RefinedPrompt {
  title: string;
  requirements: string[];
  techStack: string[];
  fullPrompt: string;
}

/**
 * Call Claude Code CLI to intelligently refine the user's raw prompt.
 * Uses async spawn so the spinner can animate while waiting.
 */
async function refinePromptWithClaude(
  rawTask: string,
  answers: Record<string, string>,
  roles: string[],
  spinner?: ReturnType<typeof ora>,
): Promise<RefinedPrompt> {
  const agentNames = roles.map((r) => ROLES[r]?.name || r);

  // Build context from follow-up answers
  let answerContext = '';
  if (answers.framework) answerContext += `\nFramework: ${answers.framework}`;
  if (answers.runtime) answerContext += `\nRuntime: ${answers.runtime}`;
  if (answers.database) answerContext += `\nDatabase: ${answers.database}`;
  if (answers.constraints) answerContext += `\nConstraints: ${answers.constraints}`;

  const refinementPrompt = `You are a prompt refinement assistant. Take the user's raw input and produce a clean, structured project prompt.

Raw user input: "${rawTask}"
${answerContext ? `\nUser preferences:${answerContext}` : ''}
Team: ${agentNames.join(', ')}

Respond ONLY with valid JSON (no markdown, no code fences, no explanation) in this exact format:
{
  "title": "A clear, concise 1-sentence project description",
  "requirements": ["requirement 1", "requirement 2", ...],
  "techStack": ["tech1", "tech2", ...],
  "fullPrompt": "The complete, well-structured prompt for the engineering team to execute. Include the title, all requirements, tech stack, and any constraints. Be specific and actionable."
}

Rules:
- title: Clean up the raw input into a professional project description
- requirements: Extract implicit AND explicit requirements (auth, responsive, real-time, etc). Include 3-8 requirements.
- techStack: Infer technologies from context, user answers, and task. If unclear, suggest sensible defaults.
- fullPrompt: This is what the engineering team will actually read. Make it detailed, actionable, and clear. Include all context.`;

  try {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    // Async spawn so the event loop stays free for spinner animation
    const output = await new Promise<string>((resolve, reject) => {
      const phases = [
        'Understanding your request...',
        'Extracting requirements...',
        'Identifying tech stack...',
        'Structuring the prompt...',
        'Finalizing...',
      ];
      let phaseIdx = 0;

      // Timer-based spinner rotation (JSON mode has no intermediate output)
      const phaseTimer = setInterval(() => {
        phaseIdx++;
        if (spinner && phaseIdx < phases.length) {
          spinner.text = phases[phaseIdx];
        }
      }, 3000);

      const child = spawnProcess('claude', [
        '-p', refinementPrompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--max-turns', '1',
        '--dangerously-skip-permissions',
      ], {
        env,
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let lineBuffer = '';

      // Line-buffered: advance spinner on each complete JSON event
      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        lineBuffer += text;

        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // Advance spinner on each stream-json event
          if (spinner && phaseIdx < phases.length) {
            spinner.text = phases[phaseIdx];
            phaseIdx++;
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const timeout = setTimeout(() => {
        clearInterval(phaseTimer);
        child.kill('SIGTERM');
        reject(new Error('timeout'));
      }, 60000);

      child.on('close', (code) => {
        clearInterval(phaseTimer);
        clearTimeout(timeout);
        if (code === 0 && stdout.trim()) {
          resolve(stdout);
        } else {
          reject(new Error(`exit ${code}: ${stderr.slice(0, 200)}`));
        }
      });

      child.on('error', (err) => {
        clearInterval(phaseTimer);
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Parse stream-json: find the result event
    let responseText = '';
    const outputLines = output.trim().split('\n');
    for (let i = outputLines.length - 1; i >= 0; i--) {
      try {
        const event = JSON.parse(outputLines[i]);
        if (event.type === 'result' && event.result) {
          responseText = event.result;
          break;
        }
      } catch {
        // skip
      }
    }

    if (!responseText) {
      // Fallback: try as single JSON
      try {
        const wrapper = JSON.parse(output.trim());
        if (wrapper.result) responseText = wrapper.result;
        else responseText = output.trim();
      } catch {
        responseText = output.trim();
      }
    }

    // Strip markdown code fences if present
    responseText = responseText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const parsed = JSON.parse(responseText);

    return {
      title: parsed.title || rawTask,
      requirements: Array.isArray(parsed.requirements) ? parsed.requirements : [],
      techStack: Array.isArray(parsed.techStack) ? parsed.techStack : [],
      fullPrompt: parsed.fullPrompt || rawTask,
    };
  } catch {
    // Fallback: if Claude fails, do basic local refinement
    return refinePromptLocal(rawTask, answers, roles);
  }
}

/**
 * Local fallback refinement (keyword matching) — used if Claude CLI fails.
 */
function refinePromptLocal(
  rawTask: string,
  answers: Record<string, string>,
  roles: string[],
): RefinedPrompt {
  let title = rawTask.trim();
  title = title.charAt(0).toUpperCase() + title.slice(1);
  if (!title.endsWith('.') && !title.endsWith('!') && !title.endsWith('?')) {
    title += '.';
  }

  const requirements: string[] = [];
  const lower = rawTask.toLowerCase();

  if (lower.includes('auth') || lower.includes('login')) requirements.push('User authentication');
  if (lower.includes('responsive') || lower.includes('mobile')) requirements.push('Responsive design');
  if (lower.includes('realtime') || lower.includes('real-time')) requirements.push('Real-time updates');
  if (lower.includes('deploy') || lower.includes('production')) requirements.push('Production-ready');
  if (lower.includes('test')) requirements.push('Test coverage');

  const techStack: string[] = [];
  if (answers.framework) techStack.push(answers.framework);
  if (answers.runtime) techStack.push(answers.runtime);
  if (answers.database) techStack.push(answers.database);
  // "constraints" answer often contains tech stack info (e.g. "react")
  if (answers.constraints) {
    const c = answers.constraints.toLowerCase();
    const knownTech = ['react', 'vue', 'svelte', 'angular', 'next', 'nuxt', 'node', 'express', 'python', 'django', 'flask', 'go', 'rust', 'postgres', 'mongodb', 'sqlite', 'redis', 'tailwind', 'typescript'];
    for (const tech of knownTech) {
      if (c.includes(tech) && !techStack.some(t => t.toLowerCase().includes(tech))) {
        techStack.push(tech.charAt(0).toUpperCase() + tech.slice(1));
      }
    }
    // If nothing matched, add as constraint text
    if (techStack.length === 0) {
      techStack.push(answers.constraints);
    }
  }

  // Auto-detect from task text
  if (lower.includes('drag') && lower.includes('drop')) requirements.push('Drag and drop functionality');
  if (lower.includes('todo') || lower.includes('task')) requirements.push('Task management');
  if (lower.includes('column') || lower.includes('kanban') || lower.includes('board')) requirements.push('Column/board layout');
  if (lower.includes('status')) requirements.push('Status tracking');

  const agentNames = roles.map((r) => ROLES[r]?.name || r);
  let fullPrompt = title;
  if (requirements.length > 0) {
    fullPrompt += '\n\nRequirements:\n' + requirements.map((r) => `- ${r}`).join('\n');
  }
  if (techStack.length > 0) {
    fullPrompt += '\n\nTech stack: ' + techStack.join(', ') + '.';
  }
  fullPrompt += `\n\nTeam: ${agentNames.join(', ')}.`;

  return { title, requirements, techStack, fullPrompt };
}

// ── Main ────────────────────────────────────────────────────

export async function startInteractiveSession(): Promise<void> {
  printBanner();

  // Step 0: New or existing project
  console.log(chalk.bold.white('  Project type:'));
  console.log(chalk.dim('  (use arrow keys, press enter to select)\n'));

  const projectTypeItems = [
    { label: 'New project', description: 'Start fresh -- agents will not search existing files' },
    { label: 'Existing project', description: 'Agents will read and build on top of current codebase' },
  ];

  const projectTypeIndex = await arrowSelect(projectTypeItems);
  const isNewProject = projectTypeIndex === 0;

  console.log();

  // Step 1: Team selection with arrow keys
  console.log(chalk.bold.white('  Select your team:'));
  console.log(chalk.dim('  (use arrow keys, press enter to select)\n'));

  const teamItems = TEAM_PRESETS.map((p) => ({
    label: p.label,
    description: p.description,
  }));

  const teamIndex = await arrowSelect(teamItems);

  let skipStages: string[];
  let selectedRoles: string[];

  if (teamIndex < TEAM_PRESETS.length - 1) {
    const preset = TEAM_PRESETS[teamIndex];
    skipStages = preset.skipStages;
    selectedRoles = preset.roles;
  } else {
    // Custom agent picker with multi-select
    console.log(chalk.bold.white('\n  Pick your agents:'));
    console.log(chalk.dim('  (space to toggle, enter to confirm)\n'));

    const agentItems = ALL_AGENTS.map((a) => ({
      label: a.label,
      description: a.desc,
    }));

    const picks = await arrowMultiSelect(agentItems);

    if (picks.length === 0) {
      selectedRoles = TEAM_PRESETS[0].roles;
      skipStages = [];
      console.log(chalk.dim('\n  No selection, using Full Team'));
    } else {
      selectedRoles = picks.map((i) => ALL_AGENTS[i].key);
      if (!selectedRoles.includes('strategist')) selectedRoles.unshift('strategist');
      if (!selectedRoles.includes('builder')) selectedRoles.push('builder');
      skipStages = resolveSkipStages(selectedRoles);
    }
  }

  // Step 1.5: Supervised mode selection
  console.log(chalk.bold.white('\n  Run mode:'));
  console.log(chalk.dim('  (use arrow keys, press enter to select)\n'));

  const modeItems = [
    { label: 'Autonomous', description: 'Agents run without asking -- fastest' },
    { label: 'Supervised', description: 'Approve each agent before it runs -- you stay in control' },
  ];

  const modeIndex = await arrowSelect(modeItems);
  const supervised = modeIndex === 1;

  console.log();

  // Step 2: Task prompt (use readline for free text)
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const task = await ask(rl, chalk.bold.white('  What do you want to build? ') + chalk.hex(THEME.primary)('> '));

  if (!task) {
    console.log(chalk.dim('\n  No task provided. Exiting.\n'));
    rl.close();
    return;
  }

  // Step 3: Smart follow-ups
  const followUps = detectFollowUps(task);
  const answers: Record<string, string> = {};

  console.log();
  for (const fu of followUps) {
    const answer = await ask(rl, chalk.dim('  ') + chalk.white(fu.question));
    if (answer && answer.toLowerCase() !== 'skip') {
      answers[fu.key] = answer;
    }
  }

  rl.close();

  // Step 4: Refine prompt using Claude CLI
  console.log();
  const refineSpinner = ora({
    text: 'Understanding your request...',
    prefixText: '  ',
    spinner: 'dots',
  }).start();

  const refined = await refinePromptWithClaude(task, answers, selectedRoles, refineSpinner);

  refineSpinner.succeed('Prompt refined');
  console.log();

  // Display the refined prompt
  const teamNames = selectedRoles.map((r) => ROLES[r]?.name || r).join(', ');
  const lines: string[] = [];
  lines.push(chalk.bold.hex(THEME.primary)('  Refined Prompt'));
  lines.push('');
  lines.push(chalk.white(`  ${refined.title}`));
  lines.push('');
  if (refined.requirements.length > 0) {
    lines.push(chalk.dim('  Requirements:'));
    for (const req of refined.requirements) {
      lines.push(chalk.dim(`    - ${req}`));
    }
    lines.push('');
  }
  if (refined.techStack.length > 0) {
    lines.push(chalk.dim('  Tech Stack:'));
    lines.push(chalk.dim(`    ${refined.techStack.join(' + ')}`));
    lines.push('');
  }
  lines.push(chalk.dim(`  Project: ${isNewProject ? 'New' : 'Existing'}`));
  lines.push(chalk.dim(`  Team: ${teamNames}`));
  lines.push(chalk.dim(`  Mode: ${supervised ? 'Supervised' : 'Autonomous'}`));

  const panel = boxen(lines.join('\n'), {
    padding: 1,
    margin: { top: 0, bottom: 0, left: 1, right: 1 },
    borderStyle: 'round',
    borderColor: '#7C3AED',
  });
  console.log(panel);
  console.log();

  // Step 5: Start engine
  const cwd = process.cwd();
  const config = await loadConfig(cwd);

  const engine = new OrchestrationEngine({
    cwd,
    maxParallel: config.maxParallelAgents,
    skipStages,
    noUi: false,
    supervised,
    agentConfig: config.agents,
    isNewProject,
  });

  const renderer = new TerminalRenderer(engine);
  setupGracefulShutdown(engine, () => renderer.cleanup());

  const result = await engine.run(refined.fullPrompt);
  renderer.printSummary(result);

  if (!result.success) {
    process.exit(1);
  }
}
