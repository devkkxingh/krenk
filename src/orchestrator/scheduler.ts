import { spawnClaudeAgent, killAgent, type AgentResult, type SpawnOptions, type AgentEmitter } from '../agents/spawner.js';

/**
 * Parallel agent scheduler with concurrency control
 */
export class Scheduler {
  private maxParallel: number;
  private running: Map<string, AgentEmitter> = new Map();

  constructor(maxParallel: number = 3) {
    this.maxParallel = maxParallel;
  }

  /**
   * Run multiple agents in parallel batches, respecting concurrency limit
   */
  async runParallel(
    agents: SpawnOptions[],
    onProgress?: (role: string, event: string, data?: unknown) => void
  ): Promise<AgentResult[]> {
    const results: AgentResult[] = [];
    const batches = this.chunk(agents, this.maxParallel);

    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map((opts) => this.runOne(opts, onProgress))
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Run a single agent and return a promise of its result
   */
  private runOne(
    opts: SpawnOptions,
    onProgress?: (role: string, event: string, data?: unknown) => void
  ): Promise<AgentResult> {
    return new Promise((resolve, reject) => {
      const emitter = spawnClaudeAgent(opts);
      this.running.set(opts.role, emitter);

      emitter.on('spawned', (pid: number) => {
        onProgress?.(opts.role, 'spawned', { pid });
      });

      emitter.on('data', (text: string) => {
        onProgress?.(opts.role, 'data', { text });
      });

      emitter.on('done', (result: AgentResult) => {
        this.running.delete(opts.role);
        onProgress?.(opts.role, 'done', result);
        resolve(result);
      });

      emitter.on('error', (err: Error) => {
        this.running.delete(opts.role);
        onProgress?.(opts.role, 'error', err);
        reject(err);
      });
    });
  }

  /**
   * Kill all currently running agents
   */
  killAll(): void {
    for (const [role, emitter] of this.running) {
      killAgent(emitter);
      this.running.delete(role);
    }
  }

  /**
   * Get count of currently running agents
   */
  getRunningCount(): number {
    return this.running.size;
  }

  /**
   * Split array into chunks of given size
   */
  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}
