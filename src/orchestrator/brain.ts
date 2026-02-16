import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import { SharedMemory } from './memory.js';
import type { AgentResult } from '../agents/spawner.js';
import type { ParsedPlan } from './plan-parser.js';
import { ROLES } from '../agents/roles.js';

/**
 * MasterBrain — the single top-level intelligence controlling the entire system.
 *
 * Combines PM duties (Director) + shared memory coordination + strategic decisions.
 *
 * What it does:
 *   1. Owns the SharedMemory — writes directives, decisions, learnings
 *   2. Prepares agent briefs WITH shared memory context
 *   3. Monitors all agent output in real-time
 *   4. Reviews output quality and decides accept/redo/skip
 *   5. Detects inter-agent conflicts
 *   6. Writes directives that running agents can discover
 *   7. Manages phased execution for long-running agents
 *   8. Tracks the big picture across the entire workflow
 *
 * Events:
 *   'brief'        → { role, brief }
 *   'review'       → { role, verdict, notes }
 *   'intervention' → { role, type, message }
 *   'directive'    → { directive }
 *   'decision'     → { decision }
 */
export class MasterBrain extends EventEmitter {
  readonly memory: SharedMemory;
  private plan: ParsedPlan | null = null;
  private agentOutputs: Map<string, string> = new Map();
  private agentLiveBuffer: Map<string, string> = new Map();
  private redoCounts: Map<string, number> = new Map();
  private readonly MAX_REDOS = 2;
  private completedRoles: Set<string> = new Set();
  private activeRoles: Set<string> = new Set();

  // Error detection patterns
  private issuePatterns: RegExp[] = [
    /error:\s+(?!.*test|.*expect|.*assert)/i,
    /FATAL/,
    /panic:/i,
    /cannot find module/i,
    /unhandled.*rejection/i,
    /out of memory/i,
    /maximum call stack/i,
    /ENOSPC/i,
    /permission denied/i,
  ];

  // Off-track detection per role
  private offTrackPatterns: Map<string, RegExp[]> = new Map([
    ['builder', [/writing tests/i, /writing documentation/i, /reviewing code/i]],
    ['guardian', [/implementing feature/i, /refactoring/i]],
    ['sentinel', [/fixing.*bug/i, /implementing/i]],
    ['scribe', [/implementing/i, /writing tests/i]],
  ]);

  constructor(projectDir: string) {
    super();
    this.memory = new SharedMemory(projectDir);
  }

  // ── Plan ────────────────────────────────────────────────

  setPlan(plan: ParsedPlan): void {
    this.plan = plan;
    this.memory.logDecision('Master plan received from Strategist');

    // Write plan summary to shared memory
    const assignedRoles = Array.from(plan.assignments.keys());
    this.memory.writeDirective(
      `## Master Plan Active\n\nAssigned agents: ${assignedRoles.map(r => ROLES[r]?.name || r).join(', ')}\nModules: ${plan.modules.length}\n\nAll agents: follow your ASSIGN section from the plan.`
    );
  }

  // ── Agent Lifecycle ─────────────────────────────────────

  /**
   * Called when an agent is about to run.
   * Prepares a complete brief with:
   *   - Shared memory context (what the team knows)
   *   - Brain's directives and decisions
   *   - Cross-agent learnings
   *   - Role-specific guardrails
   *   - Path to shared dir so agent can read more
   */
  prepareBrief(role: string, basePrompt: string): string {
    this.activeRoles.add(role);

    // Update agent status in shared memory
    this.updateStatusBoard();

    const parts: string[] = [];

    // Shared memory context
    const memoryContext = this.memory.getFullContext();
    if (memoryContext) {
      parts.push(memoryContext);
    }

    // Tell agent about shared memory directory
    parts.push(`## Shared Memory Location`);
    parts.push(`The team's shared memory is at: ${this.memory.getSharedDir()}/`);
    parts.push(`You can read any .md file there with the Read tool for full context.`);
    parts.push(`Write your progress updates to: ${this.memory.getSharedDir()}/${role}.md`);
    parts.push('');

    // Role-specific guardrails
    const guardrails = this.getGuardrails(role);
    if (guardrails) {
      parts.push('## Constraints from Master Brain:');
      parts.push(guardrails);
      parts.push('');
    }

    const brief = parts.length > 0
      ? `${parts.join('\n')}\n---\n\n${basePrompt}`
      : basePrompt;

    this.emit('brief', { role, brief: parts.join('\n') });

    // Log to shared memory
    this.memory.logDecision(`Briefed ${ROLES[role]?.name || role} and sent to work`);

    return brief;
  }

  /**
   * Called with every chunk of output from a running agent.
   * Monitors in real-time, detects problems, writes updates to shared memory.
   */
  monitorOutput(role: string, chunk: string): BrainIntervention | null {
    const existing = this.agentLiveBuffer.get(role) || '';
    this.agentLiveBuffer.set(role, existing + chunk);

    const buffer = this.agentLiveBuffer.get(role) || '';

    // Update agent progress in shared memory (every ~2KB of output)
    if (buffer.length > 0 && buffer.length % 2000 < chunk.length) {
      const lastLines = buffer.split('\n').slice(-5).join('\n');
      this.memory.writeAgentProgress(role, `# ${ROLES[role]?.name || role} — Progress\n\n_Live output (last few lines):_\n\`\`\`\n${lastLines}\n\`\`\`\n`);
    }

    // Check for fatal errors
    for (const pattern of this.issuePatterns) {
      if (pattern.test(chunk)) {
        const msg = `Error detected in ${role}: ${chunk.trim().slice(0, 100)}`;
        this.memory.logBlocker(role, msg);
        this.emit('intervention', { role, type: 'error_detected', message: msg });
        return null; // Don't kill — many errors are recoverable
      }
    }

    // Check off-track behavior
    if (buffer.length > 2000) {
      const patterns = this.offTrackPatterns.get(role);
      if (patterns) {
        for (const pattern of patterns) {
          if (pattern.test(chunk)) {
            const msg = `${role} appears to be doing work outside its scope`;
            logger.info(`Brain: ${msg}`);

            // Write a directive the agent might read
            this.memory.writeDirective(
              `## Attention ${ROLES[role]?.name || role}\n\nYou appear to be going off-track. Please stay focused on your assigned task. Do NOT do: ${pattern.source}`
            );

            this.emit('intervention', { role, type: 'off_track', message: msg });
            return { type: 'warn', role, reason: `Off-track: ${pattern.source}` };
          }
        }
      }
    }

    return null;
  }

  /**
   * Called when an agent finishes.
   * Reviews quality, extracts learnings, updates shared memory, decides next action.
   */
  reviewOutput(role: string, result: AgentResult): BrainVerdict {
    this.agentOutputs.set(role, result.output);
    this.agentLiveBuffer.delete(role);
    this.activeRoles.delete(role);

    // Write final output summary to shared memory
    const summary = this.summarizeOutput(role, result.output);
    this.memory.writeAgentProgress(role,
      `# ${ROLES[role]?.name || role} — Complete\n\nStatus: ${result.success ? 'SUCCESS' : 'FAILED'}\nDuration: ${result.duration}s\n\n## Summary:\n${summary}\n`
    );

    // Check empty/failed output
    if (!result.output || result.output.trim().length < 50) {
      if (result.success) {
        this.completedRoles.add(role);
        this.memory.logDecision(`${role}: accepted (minimal output but success)`);
        this.updateStatusBoard();
        this.emit('review', { role, verdict: 'accept', notes: 'Minimal output' });
        return { verdict: 'accept', notes: 'Minimal output' };
      }

      const redos = this.redoCounts.get(role) || 0;
      if (redos < this.MAX_REDOS) {
        this.redoCounts.set(role, redos + 1);
        this.memory.logDecision(`${role}: ordering REDO (failed with no output)`);
        this.emit('review', { role, verdict: 'redo', notes: `Redo ${redos + 1}/${this.MAX_REDOS}` });
        return {
          verdict: 'redo',
          notes: 'Failed with no output',
          correction: 'The previous attempt failed. Please try again carefully.',
        };
      }

      this.completedRoles.add(role);
      this.memory.logDecision(`${role}: accepting failure (max redos reached)`);
      this.updateStatusBoard();
      this.emit('review', { role, verdict: 'accept', notes: 'Max redos reached' });
      return { verdict: 'accept', notes: 'Max redos reached' };
    }

    // Handle agent failure
    if (!result.success) {
      const redos = this.redoCounts.get(role) || 0;
      if (redos < this.MAX_REDOS) {
        this.redoCounts.set(role, redos + 1);
        const errors = this.extractErrors(result.output);
        this.memory.logBlocker(role, `Failed (exit ${result.exitCode})`);
        this.memory.logDecision(`${role}: ordering REDO (exit code ${result.exitCode})`);
        this.emit('review', { role, verdict: 'redo', notes: `Failed, redo ${redos + 1}` });
        return {
          verdict: 'redo',
          notes: `Failed (exit ${result.exitCode})`,
          correction: `Previous attempt failed:\n\n${errors}\n\nPlease fix and try again.`,
        };
      }
    }

    // Extract learnings and update shared memory
    this.extractLearnings(role, result.output);

    // Quality checks
    const qualityIssue = this.checkQuality(role, result.output);
    if (qualityIssue) {
      const redos = this.redoCounts.get(role) || 0;
      if (redos < this.MAX_REDOS) {
        this.redoCounts.set(role, redos + 1);
        this.memory.logDecision(`${role}: ordering REDO (quality issue: ${qualityIssue})`);
        this.emit('review', { role, verdict: 'redo', notes: qualityIssue });
        return {
          verdict: 'redo',
          notes: qualityIssue,
          correction: `Quality review found issues:\n\n${qualityIssue}\n\nPlease address these.`,
        };
      }
    }

    // Detect conflicts with other agents' work
    this.detectConflicts(role, result.output);

    this.completedRoles.add(role);
    this.memory.logDecision(`${role}: ACCEPTED`);
    this.updateStatusBoard();
    this.emit('review', { role, verdict: 'accept', notes: 'OK' });
    return { verdict: 'accept', notes: 'OK' };
  }

  // ── Phased Execution ────────────────────────────────────

  /**
   * Get execution phases for a role.
   * Builder gets 3 phases with review between each.
   */
  getPhases(role: string, fullPrompt: string): string[] {
    if (role !== 'builder' || fullPrompt.length < 500) {
      return [fullPrompt];
    }

    this.memory.logDecision('Builder task is large — splitting into 3 phases');

    return [
      `PHASE 1 of 3 — SETUP\n\nFocus ONLY on: directory structure, installing dependencies, config files, boilerplate. Do NOT implement features.\n\nWrite your progress to the shared memory: ${this.memory.getSharedDir()}/builder.md\n\n${fullPrompt}`,
      `PHASE 2 of 3 — CORE\n\nSetup is done. Now implement the core features and main logic. Check ${this.memory.getSharedDir()}/brain.md for any directives from the Master Brain.\n\nContinue from where you left off.`,
      `PHASE 3 of 3 — POLISH\n\nCore is done. Handle edge cases, error handling, cleanup. Check ${this.memory.getSharedDir()}/brain.md for any final directives.\n\nContinue from where you left off.`,
    ];
  }

  /**
   * Prepare a corrected prompt for redo.
   */
  prepareRedoPrompt(role: string, originalPrompt: string, correction: string): string {
    this.memory.writeDirective(`## Redo: ${ROLES[role]?.name || role}\n\n${correction}`);
    return `${correction}\n\n---\n\nOriginal task:\n${originalPrompt}`;
  }

  getRedoCount(role: string): number {
    return this.redoCounts.get(role) || 0;
  }

  // ── Shared Memory Helpers ───────────────────────────────

  private updateStatusBoard(): void {
    const allRoles = Object.keys(ROLES);
    const agents = allRoles.map((role) => {
      let status: string;
      let info: string | undefined;

      if (this.completedRoles.has(role)) {
        const output = this.agentOutputs.get(role);
        status = 'done';
        info = output ? `${output.length} chars output` : undefined;
      } else if (this.activeRoles.has(role)) {
        status = 'active';
        const buf = this.agentLiveBuffer.get(role);
        info = buf ? `${buf.length} chars so far` : 'starting...';
      } else {
        status = 'idle';
      }

      return { role, name: ROLES[role]?.name || role, status, info };
    });

    this.memory.updateAgentStatus(agents);
  }

  private detectConflicts(role: string, output: string): void {
    // Check if this agent modified files that another agent owns
    const fileRefs = output.match(/(?:wrote|created|modified|updated|edited)\s+[`"']?([^\s`"']+\.\w+)/gi) || [];

    for (const [otherRole, otherOutput] of this.agentOutputs) {
      if (otherRole === role) continue;

      const otherFiles = (otherOutput.match(/(?:wrote|created|modified)\s+[`"']?([^\s`"']+\.\w+)/gi) || [])
        .map(m => m.replace(/^(wrote|created|modified|updated|edited)\s+[`"']?/i, ''));

      for (const ref of fileRefs) {
        const file = ref.replace(/^(wrote|created|modified|updated|edited)\s+[`"']?/i, '');
        if (otherFiles.some(f => f === file)) {
          const msg = `Possible conflict: ${role} and ${otherRole} both touched ${file}`;
          logger.info(`Brain: ${msg}`);
          this.memory.logBlocker(role, msg);
          this.memory.logDecision(`CONFLICT DETECTED: ${msg}`);
          this.emit('intervention', { role, type: 'conflict', message: msg });
        }
      }
    }
  }

  // ── Analysis Helpers ────────────────────────────────────

  private summarizeOutput(role: string, output: string): string {
    const lines = output.split('\n');
    const keyLines: string[] = [];

    for (const line of lines) {
      if (
        line.startsWith('#') ||
        line.includes('CRITICAL') ||
        line.includes('IMPORTANT') ||
        line.includes('NOTE:') ||
        line.includes('WARNING') ||
        line.includes('MODULE:') ||
        line.includes('ASSIGN:') ||
        line.includes('APPROVED') ||
        line.includes('NEEDS_REVISION')
      ) {
        keyLines.push(line);
      }
    }

    return keyLines.length > 0
      ? keyLines.slice(0, 20).join('\n')
      : output.slice(0, 500);
  }

  private getGuardrails(role: string): string | null {
    const base: Record<string, string> = {
      builder: [
        '- Stay in scope: only implement what was assigned',
        '- Do NOT write tests (Guardian handles that)',
        '- Do NOT write docs (Scribe handles that)',
        '- Write progress updates to your shared memory file',
        '- Check brain.md for any directives before starting',
      ].join('\n'),
      guardian: [
        '- Focus on TESTING only — do not fix bugs, just report them',
        '- Use the QA test plan from shared memory if available',
        '- Report results with PASS/FAIL for each test',
      ].join('\n'),
      sentinel: [
        '- Code REVIEW only — do NOT modify any code',
        '- Be specific: file path, line number, issue, fix',
        '- Say NEEDS_REVISION if critical issues found',
      ].join('\n'),
      security: [
        '- Security AUDIT only — do NOT modify any code',
        '- Check OWASP Top 10',
        '- Run dependency audits',
        '- Say NEEDS_REVISION if critical issues found',
      ].join('\n'),
      scribe: [
        '- Write docs based on ACTUAL code, not the plan',
        '- Read the codebase first',
        '- Keep docs concise',
      ].join('\n'),
    };

    return base[role] || null;
  }

  private extractErrors(output: string): string {
    const lines = output.split('\n');
    const errors = lines.filter(l =>
      /error|failed|exception|ENOENT|cannot find/i.test(l)
    ).slice(0, 15);
    return errors.length > 0 ? errors.join('\n') : output.slice(-500);
  }

  private extractLearnings(role: string, output: string): void {
    if (role === 'architect' || role === 'strategist') {
      const techs = [
        ['typescript', 'Project uses TypeScript'],
        ['react', 'Frontend uses React'],
        ['Next.js', 'Using Next.js'],
        ['express', 'Backend uses Express'],
        ['postgres', 'Database is PostgreSQL'],
        ['prisma', 'Using Prisma ORM'],
        ['tailwind', 'Using Tailwind CSS'],
      ];
      for (const [keyword, learning] of techs) {
        if (output.toLowerCase().includes(keyword.toLowerCase())) {
          this.memory.logLearning(learning);
        }
      }
    }

    if (role === 'builder') {
      const fileMatches = output.match(/(?:created|wrote|updated)\s+(?:file\s+)?[`"]?([^\s`"]+\.\w+)/gi);
      if (fileMatches) {
        this.memory.logLearning(`Builder created/modified ${fileMatches.length} files`);
      }
    }

    if (role === 'guardian') {
      const passMatch = output.match(/(\d+)\s+(?:tests?\s+)?pass/i);
      const failMatch = output.match(/(\d+)\s+(?:tests?\s+)?fail/i);
      if (passMatch || failMatch) {
        this.memory.logLearning(`Tests: ${passMatch?.[1] || 0} passed, ${failMatch?.[1] || 0} failed`);
      }
    }

    if (role === 'sentinel') {
      if (output.includes('APPROVED')) this.memory.logLearning('Code review: APPROVED');
      if (output.includes('NEEDS_REVISION')) this.memory.logLearning('Code review: NEEDS REVISION');
    }

    if (role === 'security') {
      if (output.includes('APPROVED')) this.memory.logLearning('Security audit: PASSED');
      if (output.includes('NEEDS_REVISION')) this.memory.logLearning('Security audit: ISSUES FOUND');
    }
  }

  private checkQuality(role: string, output: string): string | null {
    if (role === 'architect' && !output.match(/file|directory|structure/i)) {
      return 'Missing file structure / directory layout';
    }
    if (role === 'strategist' && !output.match(/task|step|todo|\- \[/i)) {
      return 'Missing concrete tasks';
    }
    if (role === 'guardian' && !output.match(/pass|fail|test/i)) {
      return 'Missing test results — did tests actually run?';
    }
    return null;
  }
}

// ── Types ──────────────────────────────────────────────────

export interface BrainIntervention {
  type: 'warn' | 'kill' | 'redirect';
  role: string;
  reason: string;
}

export interface BrainVerdict {
  verdict: 'accept' | 'redo' | 'skip';
  notes: string;
  correction?: string;
}
