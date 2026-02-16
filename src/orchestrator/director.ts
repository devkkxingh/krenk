import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import type { AgentResult } from '../agents/spawner.js';
import type { ParsedPlan } from './plan-parser.js';

/**
 * The Director is the PM/Supervisor brain of the orchestration system.
 *
 * It actively monitors, reviews, and coordinates agents — not just
 * fire-and-forget. Like a real PM, it:
 *
 *   1. Prepares a detailed brief before each agent runs
 *   2. Monitors output in real-time and detects problems
 *   3. Reviews output after each agent and decides next steps
 *   4. Can order a REDO if output is bad
 *   5. Passes relevant learnings between agents
 *   6. Breaks large tasks into phases with checkpoints
 *   7. Adjusts the plan based on what's actually happening
 *
 * Events emitted:
 *   'directive'    → { role, action, reason }
 *   'intervention' → { role, type, message }
 *   'brief'        → { role, brief }
 *   'review'       → { role, verdict, notes }
 */
export class Director extends EventEmitter {
  private plan: ParsedPlan | null = null;
  private agentOutputs: Map<string, string> = new Map();
  private agentLiveBuffer: Map<string, string> = new Map();
  private learnings: string[] = [];
  private redoCounts: Map<string, number> = new Map();
  private readonly MAX_REDOS = 2;

  // Real-time monitoring state
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

  private offTrackPatterns: Map<string, RegExp[]> = new Map([
    ['builder', [
      /writing tests/i,         // builder should code, not test
      /writing documentation/i, // builder should code, not document
      /reviewing code/i,        // builder should code, not review
    ]],
    ['guardian', [
      /implementing feature/i,  // tester should test, not implement
      /refactoring/i,           // tester should test, not refactor
    ]],
    ['sentinel', [
      /fixing.*bug/i,           // reviewer should review, not fix
      /implementing/i,          // reviewer should review, not code
    ]],
    ['scribe', [
      /implementing/i,          // docs should document, not code
      /writing tests/i,         // docs should document, not test
    ]],
  ]);

  /**
   * Set the current plan. Called after strategist completes.
   */
  setPlan(plan: ParsedPlan): void {
    this.plan = plan;
  }

  /**
   * Prepare a brief for an agent before it runs.
   * Includes plan assignment + context from other agents + learnings.
   */
  prepareBrief(role: string, basePrompt: string): string {
    const parts: string[] = [];

    // Add any learnings accumulated from prior agents
    if (this.learnings.length > 0) {
      parts.push('## Notes from the Project Manager:');
      for (const learning of this.learnings) {
        parts.push(`- ${learning}`);
      }
      parts.push('');
    }

    // Add relevant cross-agent context
    const crossContext = this.getCrossAgentContext(role);
    if (crossContext) {
      parts.push('## Key findings from other team members:');
      parts.push(crossContext);
      parts.push('');
    }

    // Add role-specific guardrails
    const guardrails = this.getGuardrails(role);
    if (guardrails) {
      parts.push('## Important constraints from PM:');
      parts.push(guardrails);
      parts.push('');
    }

    const brief = parts.length > 0
      ? `${parts.join('\n')}\n---\n\n${basePrompt}`
      : basePrompt;

    this.emit('brief', { role, brief: parts.join('\n') });

    return brief;
  }

  /**
   * Feed real-time output from an agent. Returns an intervention if needed.
   */
  monitorOutput(role: string, chunk: string): DirectorIntervention | null {
    // Accumulate live buffer
    const existing = this.agentLiveBuffer.get(role) || '';
    this.agentLiveBuffer.set(role, existing + chunk);

    const buffer = this.agentLiveBuffer.get(role) || '';

    // Check for fatal errors
    for (const pattern of this.issuePatterns) {
      if (pattern.test(chunk)) {
        this.emit('intervention', {
          role,
          type: 'error_detected',
          message: `Detected error pattern: ${chunk.trim().slice(0, 100)}`,
        });
        // Don't kill immediately — many errors are recoverable
        // Just log the warning for now
        return null;
      }
    }

    // Check if agent is going off-track (only after significant output)
    if (buffer.length > 2000) {
      const patterns = this.offTrackPatterns.get(role);
      if (patterns) {
        for (const pattern of patterns) {
          if (pattern.test(chunk)) {
            logger.info(`Director: ${role} may be off-track (${pattern.source})`);
            this.emit('intervention', {
              role,
              type: 'off_track',
              message: `Agent ${role} appears to be doing work outside its scope`,
            });
            // Return a correction that can be applied if the issue persists
            return {
              type: 'warn',
              role,
              reason: `Detected off-track behavior: ${pattern.source}`,
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Review an agent's completed output. Decides: accept, redo, or modify plan.
   */
  reviewOutput(role: string, result: AgentResult): DirectorVerdict {
    this.agentOutputs.set(role, result.output);
    this.agentLiveBuffer.delete(role);

    // Check if the output is empty or trivially short
    if (!result.output || result.output.trim().length < 50) {
      if (result.success) {
        // Agent succeeded but produced very little output
        this.emit('review', {
          role,
          verdict: 'accept',
          notes: 'Minimal output but agent reported success',
        });
        return { verdict: 'accept', notes: 'Minimal output' };
      }

      // Failed with no output — definitely redo
      const redos = this.redoCounts.get(role) || 0;
      if (redos < this.MAX_REDOS) {
        this.redoCounts.set(role, redos + 1);
        this.emit('review', {
          role,
          verdict: 'redo',
          notes: `Agent failed with no output. Redo ${redos + 1}/${this.MAX_REDOS}`,
        });
        return {
          verdict: 'redo',
          notes: 'Failed with no output',
          correction: 'The previous attempt failed. Please try again, paying careful attention to the error messages.',
        };
      }

      this.emit('review', { role, verdict: 'accept', notes: 'Max redos reached, accepting failure' });
      return { verdict: 'accept', notes: 'Max redos reached' };
    }

    // Check if the agent failed
    if (!result.success) {
      const redos = this.redoCounts.get(role) || 0;
      if (redos < this.MAX_REDOS) {
        this.redoCounts.set(role, redos + 1);

        // Extract useful error info from the output for the redo
        const errorContext = this.extractErrors(result.output);

        this.emit('review', {
          role,
          verdict: 'redo',
          notes: `Agent failed (exit code ${result.exitCode}). Redo ${redos + 1}/${this.MAX_REDOS}`,
        });

        return {
          verdict: 'redo',
          notes: `Failed with exit code ${result.exitCode}`,
          correction: `The previous attempt failed with the following issues:\n\n${errorContext}\n\nPlease fix these issues and try again.`,
        };
      }
    }

    // Extract learnings for future agents
    this.extractLearnings(role, result.output);

    // Check for quality issues specific to the role
    const qualityIssues = this.checkQuality(role, result.output);
    if (qualityIssues) {
      const redos = this.redoCounts.get(role) || 0;
      if (redos < this.MAX_REDOS) {
        this.redoCounts.set(role, redos + 1);
        this.emit('review', {
          role,
          verdict: 'redo',
          notes: qualityIssues,
        });
        return {
          verdict: 'redo',
          notes: qualityIssues,
          correction: `The PM reviewed your output and found issues:\n\n${qualityIssues}\n\nPlease address these and try again.`,
        };
      }
    }

    this.emit('review', { role, verdict: 'accept', notes: 'Output looks good' });
    return { verdict: 'accept', notes: 'OK' };
  }

  /**
   * Get phases for a long-running agent (like builder).
   * Breaks a large task into checkpoints the director can review between.
   */
  getPhases(role: string, fullPrompt: string): string[] {
    // Only the builder gets phased execution for now
    if (role !== 'builder') {
      return [fullPrompt];
    }

    // If the prompt is short, don't bother splitting
    if (fullPrompt.length < 500) {
      return [fullPrompt];
    }

    // Phase 1: Setup — project structure, dependencies, configs
    // Phase 2: Core — main features and logic
    // Phase 3: Polish — error handling, edge cases, cleanup
    return [
      `PHASE 1 of 3 — SETUP\n\nFocus ONLY on project setup: create directory structure, install dependencies, write config files, and set up boilerplate. Do NOT implement features yet.\n\n${fullPrompt}`,
      `PHASE 2 of 3 — CORE IMPLEMENTATION\n\nThe setup phase is complete. Now implement the core features and main logic. Focus on getting the primary functionality working.\n\nContinue from where you left off.`,
      `PHASE 3 of 3 — POLISH\n\nSetup and core implementation are complete. Now handle edge cases, add error handling, clean up code, and make sure everything works together.\n\nContinue from where you left off.`,
    ];
  }

  /**
   * After a redo, prepare the corrected prompt.
   */
  prepareRedoPrompt(role: string, originalPrompt: string, correction: string): string {
    return `${correction}\n\n---\n\nOriginal task:\n${originalPrompt}`;
  }

  /**
   * Get the number of redos performed for a role.
   */
  getRedoCount(role: string): number {
    return this.redoCounts.get(role) || 0;
  }

  // ── Private helpers ─────────────────────────────────────

  private getCrossAgentContext(role: string): string | null {
    const relevant: string[] = [];

    // Each role benefits from specific other agents' output
    const crossMap: Record<string, string[]> = {
      architect: ['analyst', 'strategist'],
      designer: ['analyst', 'strategist'],
      builder: ['architect'],
      qa: ['analyst', 'architect'],
      guardian: ['qa', 'builder'],
      sentinel: ['architect', 'builder'],
      security: ['architect', 'builder'],
      scribe: ['strategist', 'architect', 'builder'],
      devops: ['architect', 'builder'],
    };

    const sources = crossMap[role] || [];
    for (const source of sources) {
      const output = this.agentOutputs.get(source);
      if (output) {
        // Summarize — take first 500 chars of key sections
        const summary = this.summarizeOutput(source, output);
        if (summary) {
          relevant.push(`From ${source.toUpperCase()}: ${summary}`);
        }
      }
    }

    return relevant.length > 0 ? relevant.join('\n\n') : null;
  }

  private summarizeOutput(role: string, output: string): string | null {
    // Extract key sections depending on the role
    const lines = output.split('\n');
    const keyLines: string[] = [];

    for (const line of lines) {
      // Keep headings and important markers
      if (
        line.startsWith('#') ||
        line.startsWith('## ') ||
        line.startsWith('### ') ||
        line.includes('CRITICAL') ||
        line.includes('IMPORTANT') ||
        line.includes('NOTE:') ||
        line.includes('WARNING') ||
        line.includes('MODULE:') ||
        line.includes('ASSIGN:')
      ) {
        keyLines.push(line);
      }
    }

    if (keyLines.length === 0) {
      // No structure found — just take the first 300 chars
      return output.slice(0, 300);
    }

    return keyLines.slice(0, 20).join('\n');
  }

  private getGuardrails(role: string): string | null {
    const guardrails: Record<string, string> = {
      builder: [
        '- Stay in scope: only implement what was assigned to you',
        '- Do NOT write tests — the Guardian will handle that',
        '- Do NOT write documentation — the Scribe will handle that',
        '- If you encounter a blocker, document it clearly and move on',
        '- Install dependencies as needed, but prefer what the architect specified',
      ].join('\n'),
      guardian: [
        '- Focus on testing — do NOT fix bugs, just report them',
        '- Use the QA test plan as your guide if available',
        '- Run the tests and report results with PASS/FAIL for each',
        '- If a test framework is not set up, set it up first',
      ].join('\n'),
      sentinel: [
        '- This is a code REVIEW — do NOT modify any code',
        '- You only have Read, Glob, and Grep tools — use them',
        '- Be specific: file path, line number, issue, recommended fix',
        '- If you find critical issues, say NEEDS_REVISION at the top',
      ].join('\n'),
      security: [
        '- This is a security AUDIT — do NOT modify any code',
        '- Check for OWASP Top 10 vulnerabilities',
        '- Check dependencies with npm audit / pip audit if applicable',
        '- If you find critical issues, say NEEDS_REVISION at the top',
      ].join('\n'),
      scribe: [
        '- Write docs based on what was ACTUALLY built, not what was planned',
        '- Read the code to understand what exists before documenting',
        '- Keep docs concise and developer-friendly',
      ].join('\n'),
    };

    return guardrails[role] || null;
  }

  private extractErrors(output: string): string {
    const lines = output.split('\n');
    const errors: string[] = [];

    for (const line of lines) {
      if (
        /error/i.test(line) ||
        /failed/i.test(line) ||
        /exception/i.test(line) ||
        /ENOENT/i.test(line) ||
        /cannot find/i.test(line)
      ) {
        errors.push(line.trim());
      }
    }

    if (errors.length === 0) {
      return output.slice(-500); // Last 500 chars as context
    }

    return errors.slice(0, 15).join('\n');
  }

  private extractLearnings(role: string, output: string): void {
    // Extract useful info that might help future agents

    // Architect: extract tech decisions
    if (role === 'architect' || role === 'strategist') {
      if (output.includes('typescript') || output.includes('TypeScript')) {
        this.learnings.push('Project uses TypeScript');
      }
      if (output.includes('react') || output.includes('React')) {
        this.learnings.push('Frontend uses React');
      }
      if (output.includes('next') || output.includes('Next.js')) {
        this.learnings.push('Using Next.js framework');
      }
      if (output.includes('express') || output.includes('Express')) {
        this.learnings.push('Backend uses Express');
      }
      if (output.includes('postgres') || output.includes('PostgreSQL')) {
        this.learnings.push('Database is PostgreSQL');
      }
      if (output.includes('prisma') || output.includes('Prisma')) {
        this.learnings.push('Using Prisma ORM');
      }
    }

    // Builder: extract what was actually built
    if (role === 'builder') {
      const fileMatches = output.match(/(?:created|wrote|updated)\s+(?:file\s+)?[`"]?([^\s`"]+\.\w+)/gi);
      if (fileMatches && fileMatches.length > 0) {
        this.learnings.push(`Builder created/modified ${fileMatches.length} files`);
      }
    }

    // Guardian: extract test results
    if (role === 'guardian') {
      const passMatch = output.match(/(\d+)\s+(?:tests?\s+)?pass/i);
      const failMatch = output.match(/(\d+)\s+(?:tests?\s+)?fail/i);
      if (passMatch || failMatch) {
        const pass = passMatch ? passMatch[1] : '0';
        const fail = failMatch ? failMatch[1] : '0';
        this.learnings.push(`Tests: ${pass} passed, ${fail} failed`);
      }
    }

    // Sentinel: extract review outcome
    if (role === 'sentinel') {
      if (output.includes('APPROVED')) {
        this.learnings.push('Code review: APPROVED');
      } else if (output.includes('NEEDS_REVISION')) {
        this.learnings.push('Code review: NEEDS REVISION — issues found');
      }
    }
  }

  private checkQuality(role: string, output: string): string | null {
    // Role-specific quality checks

    if (role === 'architect') {
      // Architect should produce file structure
      if (!output.includes('FILE') && !output.includes('file') && !output.includes('directory')) {
        return 'Architect output is missing file structure / directory layout';
      }
    }

    if (role === 'strategist') {
      // Plan should have tasks
      if (!output.includes('TASK') && !output.includes('task') && !output.includes('- [')) {
        return 'Plan is missing concrete tasks';
      }
    }

    if (role === 'guardian') {
      // Tests should report results
      if (!output.includes('pass') && !output.includes('PASS') &&
          !output.includes('fail') && !output.includes('FAIL') &&
          !output.includes('test')) {
        return 'Test output is missing test results — did tests actually run?';
      }
    }

    return null;
  }
}

// ── Types ──────────────────────────────────────────────────

export interface DirectorIntervention {
  type: 'warn' | 'kill' | 'redirect';
  role: string;
  reason: string;
  newPrompt?: string;
}

export interface DirectorVerdict {
  verdict: 'accept' | 'redo' | 'skip';
  notes: string;
  correction?: string;
}
