import { killAgent, type AgentEmitter, type AgentResult } from './spawner.js';

export type AgentStatus = 'idle' | 'active' | 'done' | 'failed';

export interface AgentEntry {
  role: string;
  name: string;
  emoji: string;
  color: string;
  status: AgentStatus;
  pid?: number;
  emitter?: AgentEmitter;
  result?: AgentResult;
  startTime?: number;
  endTime?: number;
  output: string[];
}

/**
 * Tracks all running and completed agents
 */
export class AgentRegistry {
  private agents: Map<string, AgentEntry> = new Map();

  register(role: string, name: string, emoji: string, color: string): void {
    this.agents.set(role, {
      role,
      name,
      emoji,
      color,
      status: 'idle',
      output: [],
    });
  }

  activate(role: string, pid: number, emitter: AgentEmitter): void {
    const entry = this.agents.get(role);
    if (entry) {
      entry.status = 'active';
      entry.pid = pid;
      entry.emitter = emitter;
      entry.startTime = Date.now();
    }
  }

  complete(role: string, result: AgentResult): void {
    const entry = this.agents.get(role);
    if (entry) {
      entry.status = result.success ? 'done' : 'failed';
      entry.result = result;
      entry.endTime = Date.now();
    }
  }

  appendOutput(role: string, line: string): void {
    const entry = this.agents.get(role);
    if (entry) {
      entry.output.push(line);
      // Keep only last 100 lines per agent
      if (entry.output.length > 100) {
        entry.output = entry.output.slice(-100);
      }
    }
  }

  get(role: string): AgentEntry | undefined {
    return this.agents.get(role);
  }

  getAll(): AgentEntry[] {
    return Array.from(this.agents.values());
  }

  getActive(): AgentEntry[] {
    return this.getAll().filter((a) => a.status === 'active');
  }

  getDuration(role: string): number | undefined {
    const entry = this.agents.get(role);
    if (!entry?.startTime) return undefined;
    const end = entry.endTime || Date.now();
    return Math.round((end - entry.startTime) / 1000);
  }

  /**
   * Kill all active agent processes (for graceful shutdown)
   */
  killAll(): void {
    for (const entry of this.getActive()) {
      if (entry.emitter) {
        killAgent(entry.emitter);
      }
    }
  }
}
