import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import boxen from 'boxen';
import gradient from 'gradient-string';
import figlet from 'figlet';
import type { OrchestrationEngine } from '../orchestrator/engine.js';
import type { Stage, StageInfo } from '../orchestrator/workflow.js';
import type { ProcessStats } from '../orchestrator/supervisor.js';
import { STAGES } from '../orchestrator/workflow.js';
import { ROLES } from '../agents/roles.js';
import { THEME } from './theme.js';
import { formatDuration } from '../utils/process.js';

interface AgentTiming {
  role: string;
  name: string;
  emoji: string;
  startTime: number;
  endTime?: number;
  success?: boolean;
}

/** Rotating status phrases per role so users see what's happening */
const AGENT_PHASES: Record<string, string[]> = {
  strategist: [
    'analyzing requirements...',
    'breaking down the problem...',
    'identifying modules and tasks...',
    'estimating complexity...',
    'drafting implementation plan...',
    'defining file structure...',
    'mapping dependencies...',
    'finalizing plan...',
  ],
  designer: [
    'studying user flows...',
    'mapping component hierarchy...',
    'designing layouts...',
    'choosing color palette and typography...',
    'planning interactions and animations...',
    'writing component specs...',
  ],
  architect: [
    'designing system architecture...',
    'defining data models...',
    'planning API endpoints...',
    'setting up project skeleton...',
    'resolving dependencies...',
    'splitting into parallel modules...',
    'creating boilerplate files...',
  ],
  builder: [
    'reading the plan and architecture...',
    'installing dependencies...',
    'writing core modules...',
    'implementing features...',
    'connecting components...',
    'handling edge cases...',
    'cleaning up code...',
  ],
  guardian: [
    'scanning the codebase...',
    'writing unit tests...',
    'writing integration tests...',
    'running test suite...',
    'checking coverage...',
    'fixing failing tests...',
    'reporting results...',
  ],
  sentinel: [
    'reading through all files...',
    'checking for bugs and logic errors...',
    'scanning for security issues...',
    'reviewing performance patterns...',
    'checking code style and consistency...',
    'verifying architecture compliance...',
    'writing review summary...',
  ],
  scribe: [
    'reading the codebase...',
    'writing README...',
    'documenting API endpoints...',
    'adding setup instructions...',
    'writing usage examples...',
    'finalizing docs...',
  ],
  analyst: [
    'understanding the problem domain...',
    'identifying user personas...',
    'writing user stories...',
    'defining acceptance criteria...',
    'mapping edge cases...',
    'prioritizing requirements...',
    'finalizing business specs...',
  ],
  qa: [
    'analyzing codebase for testability...',
    'defining test strategy...',
    'writing test cases...',
    'creating test matrix...',
    'identifying edge cases and boundaries...',
    'building regression checklist...',
    'finalizing test plan...',
  ],
  devops: [
    'analyzing project structure...',
    'setting up CI pipeline...',
    'writing Dockerfile...',
    'configuring deployment...',
    'setting up environment variables...',
    'adding health checks...',
    'finalizing infrastructure...',
  ],
  security: [
    'scanning for injection vulnerabilities...',
    'checking authentication flows...',
    'reviewing authorization logic...',
    'searching for exposed secrets...',
    'auditing dependencies...',
    'checking configuration security...',
    'writing security report...',
  ],
};

/**
 * Direct terminal renderer that replaces React/Ink.
 * Subscribes to engine events and writes beautiful output to stdout.
 */
export class TerminalRenderer {
  private engine: OrchestrationEngine;
  private spinners: Map<string, Ora> = new Map();
  private agentTimings: AgentTiming[] = [];
  private completedStages: number = 0;
  private totalStages: number = 0;
  private currentStage: Stage | null = null;
  private phaseTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private phaseIndex: Map<string, number> = new Map();
  private latestStats: ProcessStats[] = [];
  private killedAgents: { role: string; pid: number; reason: string }[] = [];
  private lastRealUpdate: Map<string, number> = new Map();
  private lastAgentOutput: Map<string, string> = new Map();

  constructor(engine: OrchestrationEngine) {
    this.engine = engine;
    this.totalStages = this.countActiveStages();
    this.bindEvents();
  }

  /**
   * Print the ASCII banner with gradient
   */
  printBanner(): void {
    const ascii = figlet.textSync('KRENK', { font: 'ANSI Shadow' });
    console.log(gradient(THEME.gradient)(ascii));
    console.log(chalk.gray('  Multi-Agent Software Engineering Orchestrator'));
    console.log(chalk.gray('  ' + '-'.repeat(50)));
    console.log();
  }

  /**
   * Print the user prompt being executed
   */
  printPrompt(prompt: string): void {
    console.log(chalk.dim(`  Prompt: ${prompt}`));
    console.log();
  }

  /**
   * Print the final summary after engine completes
   */
  printSummary(result: { success: boolean; stages: number; duration: number }): void {
    console.log();

    const lines: string[] = [];

    // Header
    if (result.success) {
      lines.push(chalk.bold.green('[done] Workflow Complete'));
    } else {
      lines.push(chalk.bold.red('[fail] Workflow Failed'));
    }
    lines.push('');

    // Stats
    lines.push(chalk.white(`  Stages completed: ${chalk.bold(String(result.stages))}`));
    lines.push(chalk.white(`  Total duration:   ${chalk.bold(formatDuration(result.duration))}`));
    lines.push('');

    // Agent results
    lines.push(chalk.bold.white('  Agent Results:'));
    for (const agent of this.agentTimings) {
      const duration = agent.endTime
        ? Math.round((agent.endTime - agent.startTime) / 1000)
        : 0;
      const killed = this.killedAgents.find((k) => k.role === agent.role);
      let status: string;
      if (killed) {
        status = chalk.red('x killed');
      } else if (agent.success) {
        status = chalk.green('+ pass');
      } else {
        status = chalk.red('x fail');
      }

      // Show peak memory if we have stats
      const stat = this.latestStats.find((s) => s.role === agent.role);
      const memInfo = stat ? chalk.dim(` ${stat.memoryMB}MB`) : '';

      lines.push(
        `    ${agent.emoji} ${chalk.white(agent.name.padEnd(12))} ${status}  ${chalk.dim(`${duration}s`)}${memInfo}`
      );
    }

    // Show killed agents summary if any
    if (this.killedAgents.length > 0) {
      lines.push('');
      lines.push(chalk.bold.yellow('  Supervisor Actions:'));
      for (const k of this.killedAgents) {
        const roleDef = ROLES[k.role] || ROLES[k.role.replace(/-\d+$/, '')];
        const name = roleDef?.name || k.role;
        lines.push(chalk.yellow(`    x ${name} (PID ${k.pid}): ${k.reason}`));
      }
    }

    const panel = boxen(lines.join('\n'), {
      padding: 1,
      margin: { top: 0, bottom: 1, left: 1, right: 1 },
      borderStyle: 'round',
      borderColor: result.success ? 'green' : 'red',
    });

    console.log(panel);
  }

  /**
   * Prompt user to approve/skip/abort an agent (supervised mode).
   * Uses arrow-key selection directly in the terminal.
   */
  private handleApprovalRequest({ role, tools }: { role: string; tools: string[] }): void {
    const roleDef = ROLES[role] || ROLES[role.replace(/-\d+$/, '')];
    const name = roleDef?.name || role;
    const emoji = roleDef?.emoji || '>';
    const desc = roleDef?.description || '';

    console.log();
    console.log(chalk.bold.hex('#A78BFA')(`  -- Approval Required --`));
    console.log();
    console.log(chalk.white(`  Next:   ${emoji} ${chalk.bold(name)}`));
    console.log(chalk.dim(`          ${desc}`));
    console.log(chalk.dim(`  Tools:  ${tools.join(', ')}`));

    // Show what the previous agent produced so user can make an informed decision
    const prevOutput = this.findPreviousOutput(role);
    if (prevOutput) {
      console.log();
      console.log(chalk.hex(THEME.secondary)(`  Previous output preview:`));
      const preview = this.extractPreview(prevOutput, 8);
      for (const line of preview) {
        console.log(chalk.dim(`    ${line}`));
      }
    }

    console.log();

    const options = ['Approve', 'Skip', 'Abort'] as const;
    let selected = 0;

    const render = () => {
      for (let i = 0; i < options.length; i++) {
        const pointer = i === selected ? chalk.hex('#A78BFA')('>') : ' ';
        const label = i === selected
          ? chalk.bold.white(options[i])
          : chalk.dim(options[i]);
        process.stdout.write(`    ${pointer} ${label}\n`);
      }
    };

    const clear = () => {
      for (let i = 0; i < options.length; i++) {
        process.stdout.write('\x1b[1A\x1b[2K');
      }
    };

    render();

    const wasRaw = process.stdin.isRaw;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    const onKey = (key: Buffer) => {
      const str = key.toString();

      if (str === '\x03') {
        if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false);
        process.stdin.pause();
        process.stdin.removeListener('data', onKey);
        this.engine.emit('approve:response', 'abort');
        return;
      }

      if (str === '\x1b[A' && selected > 0) {
        selected--;
        clear();
        render();
      }

      if (str === '\x1b[B' && selected < options.length - 1) {
        selected++;
        clear();
        render();
      }

      if (str === '\r' || str === '\n') {
        if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false);
        process.stdin.pause();
        process.stdin.removeListener('data', onKey);
        clear();
        const choice = options[selected];
        const color = choice === 'Approve' ? chalk.green : choice === 'Skip' ? chalk.yellow : chalk.red;
        console.log(`    ${color('>')} ${chalk.bold(choice)}`);
        console.log();
        const response = choice.toLowerCase() as 'approve' | 'skip' | 'abort';
        this.engine.emit('approve:response', response);
      }
    };

    process.stdin.on('data', onKey);
  }

  /**
   * Stop all active spinners (for Ctrl+C cleanup)
   */
  cleanup(): void {
    for (const [, timer] of this.phaseTimers) {
      clearInterval(timer);
    }
    this.phaseTimers.clear();
    for (const [, spinner] of this.spinners) {
      spinner.stop();
    }
    this.spinners.clear();
  }

  // ── Private ──────────────────────────────────────────────

  private bindEvents(): void {
    this.engine.on('stage', (stage: Stage) => this.onStage(stage));
    this.engine.on('agent:spawned', ({ role, pid }: { role: string; pid: number }) =>
      this.onAgentSpawned(role, pid)
    );
    this.engine.on('output', ({ role, text }: { role: string; text: string }) =>
      this.onAgentOutput(role, text)
    );
    this.engine.on('agent:done', ({ role, result }: { role: string; result: { success: boolean; duration: number; output?: string } }) =>
      this.onAgentDone(role, result)
    );
    this.engine.on('agent:error', ({ role, error }: { role: string; error: Error }) =>
      this.onAgentError(role, error)
    );
    // Supervised mode: approval prompts
    this.engine.on('approve:request', (data: { role: string; tools: string[] }) =>
      this.handleApprovalRequest(data)
    );

    // Plan parsed event: show which agents got assignments
    this.engine.on('plan:parsed', ({ assignments, modules }: { assignments: string[]; modules: number }) => {
      this.onPlanParsed(assignments, modules);
    });

    // Director events: PM brain actions
    this.engine.on('director:review', ({ role, verdict, notes }: { role: string; verdict: string; notes: string }) => {
      this.onDirectorReview(role, verdict, notes);
    });
    this.engine.on('director:redo', ({ role, reason }: { role: string; reason: string }) => {
      this.onDirectorRedo(role, reason);
    });
    this.engine.on('director:intervention', ({ role, type, message }: { role: string; type: string; message: string }) => {
      this.onDirectorIntervention(role, type, message);
    });
    this.engine.on('director:phase', ({ role, phase, total }: { role: string; phase: number; total: number }) => {
      this.onDirectorPhase(role, phase, total);
    });

    // Supervisor events: resource monitoring
    this.engine.on('supervisor:stats', (stats: ProcessStats[]) => {
      this.latestStats = stats;
    });
    this.engine.on('supervisor:warning', ({ role, reason }: { role: string; pid: number; reason: string }) => {
      this.onSupervisorWarning(role, reason);
    });
    this.engine.on('supervisor:killed', ({ role, pid, reason }: { role: string; pid: number; reason: string }) => {
      this.onSupervisorKilled(role, pid, reason);
    });
  }

  private onStage(stage: Stage): void {
    this.currentStage = stage;

    if (stage === 'complete') return;

    const info = STAGES.find((s) => s.stage === stage);
    if (!info) return;

    // Print stage header
    const label = `${info.emoji} ${info.label.toUpperCase()}`;
    const line = '-'.repeat(Math.max(0, 45 - label.length));
    console.log();
    console.log(chalk.bold.cyan(`  --- ${label} ${line}`));
    console.log(chalk.dim(`  ${info.description}`));
    console.log();
  }

  private onAgentSpawned(role: string, _pid: number): void {
    const baseRole = role.replace(/-\d+$/, '');
    const roleDef = ROLES[role] || ROLES[baseRole];
    const name = roleDef?.name || role;
    const emoji = roleDef?.emoji || '>';

    // Track timing
    this.agentTimings.push({
      role,
      name,
      emoji,
      startTime: Date.now(),
    });

    // Get phase messages for this role
    const phases = AGENT_PHASES[baseRole] || [`${name} is working...`];
    this.phaseIndex.set(role, 0);

    // Start spinner with first phase message
    const spinner = ora({
      text: `${name} -- ${chalk.dim(phases[0])}`,
      prefixText: `  ${emoji}`,
      spinner: 'dots',
    }).start();

    this.spinners.set(role, spinner);

    // Fallback: rotate phase messages every 8s ONLY when no real stream events are flowing
    const timer = setInterval(() => {
      const lastReal = this.lastRealUpdate.get(role) || 0;
      const sinceReal = Date.now() - lastReal;

      // Skip if a real stream-json event updated the spinner within 10s
      if (sinceReal < 10000) return;

      const idx = (this.phaseIndex.get(role) || 0) + 1;
      // Loop phases instead of stopping at the last one
      this.phaseIndex.set(role, idx % phases.length);
      const currentIdx = idx % phases.length;
      const elapsed = Math.round((Date.now() - (this.agentTimings.find(a => a.role === role)?.startTime || Date.now())) / 1000);
      const sp = this.spinners.get(role);
      if (sp) {
        const stat = this.latestStats.find((s) => s.role === role);
        const memStr = stat ? chalk.dim(` | ${stat.memoryMB}MB`) : '';
        sp.text = `${name} -- ${chalk.dim(phases[currentIdx])}  ${chalk.dim.italic(`${elapsed}s`)}${memStr}`;
      }
    }, 8000);

    this.phaseTimers.set(role, timer);
  }

  private onAgentOutput(role: string, text: string): void {
    const spinner = this.spinners.get(role);
    if (!spinner) return;

    const baseRole = role.replace(/-\d+$/, '');
    const roleDef = ROLES[role] || ROLES[baseRole];
    const name = roleDef?.name || role;
    const elapsed = Math.round((Date.now() - (this.agentTimings.find(a => a.role === role)?.startTime || Date.now())) / 1000);
    const stat = this.latestStats.find((s) => s.role === role);
    const memStr = stat ? chalk.dim(` | ${stat.memoryMB}MB`) : '';

    // Each `text` is a complete JSON line from the line-buffered spawner
    try {
      const event = JSON.parse(text);

      // assistant events contain content blocks: text, tool_use, etc.
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          // Tool use — show which tool the agent is calling
          if (block.type === 'tool_use') {
            const toolName = block.name || '';
            const input = block.input || {};
            let detail = '';

            if (toolName === 'Read' && input.file_path) {
              detail = `reading ${input.file_path.split('/').pop()}`;
            } else if (toolName === 'Write' && input.file_path) {
              detail = `writing ${input.file_path.split('/').pop()}`;
            } else if (toolName === 'Edit' && input.file_path) {
              detail = `editing ${input.file_path.split('/').pop()}`;
            } else if (toolName === 'Bash') {
              const cmd = (input.command || '').slice(0, 40);
              detail = `running: ${cmd}`;
            } else if (toolName === 'Glob') {
              detail = `searching files: ${input.pattern || ''}`;
            } else if (toolName === 'Grep') {
              detail = `searching for: ${(input.pattern || '').slice(0, 30)}`;
            } else if (toolName === 'WebSearch') {
              detail = `searching web: ${(input.query || '').slice(0, 30)}`;
            } else {
              detail = `using ${toolName}`;
            }

            spinner.text = `${name} -- ${chalk.dim(detail)}  ${chalk.dim.italic(`${elapsed}s`)}${memStr}`;
            this.lastRealUpdate.set(role, Date.now());
            return;
          }

          // Text output — show a snippet of what the agent is thinking/writing
          if (block.type === 'text' && block.text) {
            const snippet = block.text.trim().slice(0, 70).replace(/\n/g, ' ');
            if (snippet) {
              spinner.text = `${name} -- ${chalk.dim(snippet)}  ${chalk.dim.italic(`${elapsed}s`)}${memStr}`;
              this.lastRealUpdate.set(role, Date.now());
              return;
            }
          }
        }
      }

      // user events (tool results) — show tool result came back
      if (event.type === 'user') {
        spinner.text = `${name} -- ${chalk.dim('processing result...')}  ${chalk.dim.italic(`${elapsed}s`)}${memStr}`;
        this.lastRealUpdate.set(role, Date.now());
        return;
      }
    } catch {
      // Not valid JSON — ignore
    }
  }

  private onAgentDone(role: string, result: { success: boolean; duration: number; output?: string }): void {
    // Stop phase timer
    const timer = this.phaseTimers.get(role);
    if (timer) {
      clearInterval(timer);
      this.phaseTimers.delete(role);
    }

    const spinner = this.spinners.get(role);
    const roleDef = ROLES[role] || ROLES[role.replace(/-\d+$/, '')];
    const name = roleDef?.name || role;
    const emoji = roleDef?.emoji || '>';

    // Update timing
    const timing = this.agentTimings.find((a) => a.role === role);
    if (timing) {
      timing.endTime = Date.now();
      timing.success = result.success;
    }

    if (spinner) {
      if (result.success) {
        spinner.succeed(`${emoji} ${name} completed (${result.duration}s)`);
      } else {
        spinner.fail(`${emoji} ${name} failed (${result.duration}s)`);
        // Log failure details so users can debug
        if (result.output && result.output.trim()) {
          const errSnippet = result.output.trim().slice(0, 300);
          console.log(chalk.yellow(`  Error output: ${errSnippet}`));
        }
        if (result.exitCode !== null && result.exitCode !== 0) {
          console.log(chalk.dim(`  Exit code: ${result.exitCode}. Make sure "claude" CLI is in your PATH.`));
        }
      }
      this.spinners.delete(role);
    }

    // Store output for showing in approval prompts
    if (result.output) {
      this.lastAgentOutput.set(role, result.output);
    }

    // Show output preview after agent completes
    if (result.success && result.output) {
      const baseRole = role.replace(/-\d+$/, '');
      // For strategist/analyst: show more since users need to see the plan
      const maxLines = (baseRole === 'strategist' || baseRole === 'analyst') ? 15 : 8;
      const preview = this.extractPreview(result.output, maxLines);
      if (preview.length > 0) {
        console.log();
        console.log(chalk.hex(THEME.secondary)('  Output:'));
        for (const line of preview) {
          console.log(chalk.white(`    ${line}`));
        }
        console.log(chalk.dim(`    ... (full output saved to .krenk/${baseRole}.md)`));
        console.log();
      }
    }

    // Stage progress bar (only for main stages, not sub-builders)
    if (!role.includes('-')) {
      this.completedStages++;
      this.printProgress();
    }
  }

  private onAgentError(role: string, error: Error): void {
    // Stop phase timer
    const timer = this.phaseTimers.get(role);
    if (timer) {
      clearInterval(timer);
      this.phaseTimers.delete(role);
    }

    const spinner = this.spinners.get(role);
    const roleDef = ROLES[role] || ROLES[role.replace(/-\d+$/, '')];
    const name = roleDef?.name || role;
    const emoji = roleDef?.emoji || '>';

    // Update timing
    const timing = this.agentTimings.find((a) => a.role === role);
    if (timing) {
      timing.endTime = Date.now();
      timing.success = false;
    }

    if (spinner) {
      spinner.fail(`${emoji} ${name} error: ${error.message}`);
      if (error.message.includes('ENOENT')) {
        console.log(chalk.yellow(`  "claude" command not found. Make sure Claude Code CLI is installed and in your PATH.`));
        console.log(chalk.dim(`  Install: npm install -g @anthropic-ai/claude-code`));
      }
      this.spinners.delete(role);
    }
  }

  private onDirectorReview(role: string, verdict: string, notes: string): void {
    const roleDef = ROLES[role] || ROLES[role.replace(/-\d+$/, '')];
    const name = roleDef?.name || role;

    if (verdict === 'redo') {
      console.log(chalk.yellow(`  PM: ${name} output needs work — ${notes}`));
    }
    // 'accept' is silent — no need to clutter the output
  }

  private onDirectorRedo(role: string, reason: string): void {
    const roleDef = ROLES[role] || ROLES[role.replace(/-\d+$/, '')];
    const name = roleDef?.name || role;
    const emoji = roleDef?.emoji || '>';

    console.log();
    console.log(chalk.yellow(`  ${emoji} PM is re-running ${name}: ${reason}`));
    console.log();
  }

  private onDirectorIntervention(role: string, type: string, message: string): void {
    const roleDef = ROLES[role] || ROLES[role.replace(/-\d+$/, '')];
    const name = roleDef?.name || role;

    const spinner = this.spinners.get(role);
    if (spinner && type === 'off_track') {
      // Flash the warning on the spinner
      const prevText = spinner.text;
      spinner.color = 'yellow';
      spinner.text = `${name} -- ${chalk.yellow(`PM: ${message}`)}`;
      setTimeout(() => {
        if (this.spinners.has(role)) {
          spinner.color = 'cyan';
          spinner.text = prevText;
        }
      }, 5000);
    } else if (type === 'error_detected') {
      // Show error detection subtly
      if (spinner) {
        const prevText = spinner.text;
        spinner.color = 'red';
        setTimeout(() => {
          if (this.spinners.has(role)) {
            spinner.color = 'cyan';
            spinner.text = prevText;
          }
        }, 3000);
      }
    }
  }

  private onDirectorPhase(role: string, phase: number, total: number): void {
    const roleDef = ROLES[role] || ROLES[role.replace(/-\d+$/, '')];
    const name = roleDef?.name || role;
    const emoji = roleDef?.emoji || '>';

    console.log();
    console.log(chalk.hex(THEME.primary)(`  ${emoji} ${name} — Phase ${phase}/${total}`));
  }

  private onPlanParsed(assignments: string[], modules: number): void {
    console.log();
    console.log(chalk.bold.hex(THEME.primary)('  --- MASTER PLAN READY ---'));
    console.log();

    if (assignments.length > 0) {
      console.log(chalk.white('  Agent assignments:'));
      for (const role of assignments) {
        const roleDef = ROLES[role];
        if (roleDef) {
          console.log(chalk.dim(`    ${roleDef.emoji} ${roleDef.name}: assigned`));
        }
      }
    }

    if (modules > 0) {
      console.log(chalk.dim(`\n  ${modules} module(s) identified for parallel coding`));
    }

    console.log();
  }

  private onSupervisorWarning(role: string, reason: string): void {
    const roleDef = ROLES[role] || ROLES[role.replace(/-\d+$/, '')];
    const name = roleDef?.name || role;
    const spinner = this.spinners.get(role);

    // Temporarily update spinner to show the warning
    if (spinner) {
      const prevText = spinner.text;
      spinner.color = 'yellow';
      spinner.text = `${name} -- ${chalk.yellow(`! ${reason}`)}`;

      // Revert after 5 seconds
      setTimeout(() => {
        if (this.spinners.has(role)) {
          spinner.color = 'cyan';
          spinner.text = prevText;
        }
      }, 5000);
    }
  }

  private onSupervisorKilled(role: string, pid: number, reason: string): void {
    const roleDef = ROLES[role] || ROLES[role.replace(/-\d+$/, '')];
    const name = roleDef?.name || role;
    const emoji = roleDef?.emoji || '>';
    const spinner = this.spinners.get(role);

    this.killedAgents.push({ role, pid, reason });

    if (spinner) {
      spinner.fail(`${emoji} ${name} killed by supervisor: ${reason}`);
      this.spinners.delete(role);
    } else {
      console.log(chalk.red(`  x ${emoji} ${name} killed by supervisor: ${reason}`));
    }

    // Clean up phase timer
    const timer = this.phaseTimers.get(role);
    if (timer) {
      clearInterval(timer);
      this.phaseTimers.delete(role);
    }
  }

  /**
   * Extract a meaningful preview from agent output.
   * Shows headings, key bullets, and skips generic fluff.
   */
  private extractPreview(output: string, maxLines: number): string[] {
    const lines = output.split('\n');
    const preview: string[] = [];

    // Skip generic intro lines
    const skipPatterns = [
      /^(here'?s|the|this is|below|i'?ll|let me|ready for)/i,
      /^(sure|okay|alright)/i,
    ];

    for (const raw of lines) {
      if (preview.length >= maxLines) break;

      const line = raw.trimEnd();
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Skip generic intro sentences
      if (preview.length === 0 && skipPatterns.some((p) => p.test(trimmed))) {
        continue;
      }

      // Headings — always include
      if (/^#{1,4}\s+/.test(trimmed)) {
        preview.push(trimmed.slice(0, 90));
        continue;
      }

      // Bullets and numbered items — include
      if (/^[-*]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
        preview.push(trimmed.slice(0, 90));
        continue;
      }

      // ASSIGN sections — important for strategist
      if (/^###?\s*ASSIGN/i.test(trimmed)) {
        preview.push(trimmed.slice(0, 90));
        continue;
      }

      // Regular text — include if short enough and meaningful
      if (trimmed.length > 5 && trimmed.length < 120) {
        preview.push(trimmed.slice(0, 90));
      }
    }

    return preview;
  }

  /**
   * Find the most recent agent's output that ran before the given role.
   */
  private findPreviousOutput(role: string): string | null {
    const order = [
      'analyst', 'strategist', 'designer', 'architect', 'builder',
      'qa', 'guardian', 'sentinel', 'security', 'scribe', 'devops',
    ];
    const baseRole = role.replace(/-\d+$/, '');
    const idx = order.indexOf(baseRole);

    // Walk backwards to find the last agent that has output
    for (let i = idx - 1; i >= 0; i--) {
      const output = this.lastAgentOutput.get(order[i]);
      if (output) return output;
    }
    return null;
  }

  private printProgress(): void {
    const total = this.totalStages;
    const done = this.completedStages;
    const filled = '#'.repeat(done);
    const empty = '-'.repeat(Math.max(0, total - done));
    console.log(chalk.dim(`  [${filled}${empty}] ${done}/${total} stages`));
  }

  private countActiveStages(): number {
    const skipStages = this.engine['opts']?.skipStages || [];
    return STAGES.filter(
      (s) => s.stage !== 'complete' && !skipStages.includes(s.stage)
    ).length;
  }
}
