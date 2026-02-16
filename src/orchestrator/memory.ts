import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';

/**
 * SharedMemory — the team's shared knowledge base.
 *
 * A hybrid in-memory + file system that ALL agents can read.
 * Files live in `.krenk/shared/` so agents with Read/Glob tools
 * can discover and read them during execution.
 *
 * Sections:
 *   brain.md        — Master Brain's directives and decisions
 *   status.md       — Live status of all agents
 *   <role>.md       — Each agent's progress updates
 *   learnings.md    — Accumulated knowledge across agents
 *   blockers.md     — Known issues and blockers
 *   decisions.md    — Architectural and design decisions made
 *
 * Events:
 *   'update' → { section, role, content }
 */
export class SharedMemory extends EventEmitter {
  private store: Map<string, string> = new Map();
  private sharedDir: string;
  private krenkDir: string;

  constructor(projectDir: string) {
    super();
    this.krenkDir = path.join(projectDir, '.krenk');
    this.sharedDir = path.join(this.krenkDir, 'shared');
    fs.mkdirSync(this.sharedDir, { recursive: true });

    // Initialize core files
    this.writeSection('brain', '# Master Brain Directives\n\n_No directives yet._\n');
    this.writeSection('status', '# Agent Status\n\n_Starting..._\n');
    this.writeSection('learnings', '# Team Learnings\n\n');
    this.writeSection('blockers', '# Known Blockers\n\n_None yet._\n');
    this.writeSection('decisions', '# Decisions Log\n\n');
  }

  // ── Read ────────────────────────────────────────────────

  /**
   * Get a section from memory.
   */
  get(section: string): string {
    return this.store.get(section) || '';
  }

  /**
   * Get the full shared memory as a single context string.
   * This is injected into agent prompts so they see the team state.
   */
  getFullContext(): string {
    const parts: string[] = ['# Shared Team Memory (.krenk/shared/)\n'];
    parts.push('You can read these files with the Read tool for more detail.\n');

    // Brain directives (most important)
    const brain = this.store.get('brain');
    if (brain) {
      parts.push(brain);
      parts.push('');
    }

    // Current status
    const status = this.store.get('status');
    if (status) {
      parts.push(status);
      parts.push('');
    }

    // Learnings
    const learnings = this.store.get('learnings');
    if (learnings && learnings.split('\n').length > 3) {
      parts.push(learnings);
      parts.push('');
    }

    // Blockers
    const blockers = this.store.get('blockers');
    if (blockers && !blockers.includes('None yet')) {
      parts.push(blockers);
      parts.push('');
    }

    // Decisions
    const decisions = this.store.get('decisions');
    if (decisions && decisions.split('\n').length > 3) {
      parts.push(decisions);
      parts.push('');
    }

    return parts.join('\n');
  }

  /**
   * Get the path to the shared directory (so agents know where to look).
   */
  getSharedDir(): string {
    return this.sharedDir;
  }

  // ── Write ───────────────────────────────────────────────

  /**
   * Write/overwrite a section.
   */
  writeSection(section: string, content: string): void {
    this.store.set(section, content);
    this.writeToDisk(section, content);
    this.emit('update', { section, content });
  }

  /**
   * Append to a section.
   */
  appendSection(section: string, line: string): void {
    const existing = this.store.get(section) || '';
    const updated = existing + line + '\n';
    this.store.set(section, updated);
    this.writeToDisk(section, updated);
    this.emit('update', { section, content: updated });
  }

  // ── Agent Status ────────────────────────────────────────

  /**
   * Update the live status board.
   */
  updateAgentStatus(
    agents: { role: string; name: string; status: string; info?: string }[]
  ): void {
    const lines = ['# Agent Status\n'];
    const now = new Date().toLocaleTimeString();
    lines.push(`_Updated: ${now}_\n`);

    for (const a of agents) {
      const statusIcon =
        a.status === 'active' ? '>' :
        a.status === 'done' ? '+' :
        a.status === 'failed' ? 'x' :
        a.status === 'idle' ? '-' : '?';
      const info = a.info ? ` — ${a.info}` : '';
      lines.push(`${statusIcon} **${a.name}**: ${a.status}${info}`);
    }

    this.writeSection('status', lines.join('\n') + '\n');
  }

  /**
   * Write an individual agent's progress file.
   */
  writeAgentProgress(role: string, content: string): void {
    this.store.set(`agent-${role}`, content);
    this.writeToDisk(role, content);
  }

  // ── Brain Directives ────────────────────────────────────

  /**
   * Write a directive from the Master Brain.
   */
  writeDirective(directive: string): void {
    this.appendSection('brain', `\n---\n${directive}\n`);
  }

  /**
   * Log a decision.
   */
  logDecision(decision: string): void {
    const timestamp = new Date().toLocaleTimeString();
    this.appendSection('decisions', `- [${timestamp}] ${decision}\n`);
  }

  /**
   * Log a learning.
   */
  logLearning(learning: string): void {
    this.appendSection('learnings', `- ${learning}\n`);
  }

  /**
   * Log a blocker.
   */
  logBlocker(role: string, blocker: string): void {
    const content = this.store.get('blockers') || '';
    // Replace "None yet" with actual blockers
    const updated = content.includes('None yet')
      ? `# Known Blockers\n\n- [${role}] ${blocker}\n`
      : content + `- [${role}] ${blocker}\n`;
    this.writeSection('blockers', updated);
  }

  // ── Private ─────────────────────────────────────────────

  private writeToDisk(name: string, content: string): void {
    try {
      const filePath = path.join(this.sharedDir, `${name}.md`);
      fs.writeFileSync(filePath, content, 'utf-8');
    } catch (err) {
      logger.error(`SharedMemory: failed to write ${name}.md`);
    }
  }
}
