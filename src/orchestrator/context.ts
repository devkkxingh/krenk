import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Hybrid context manager: in-memory passing + file persistence in .krenk/
 */
export class ContextManager {
  private memory: Map<string, string> = new Map();
  private krenkDir: string;
  private historyDir: string;
  private runId: string;

  constructor(projectDir: string, existingRunId?: string) {
    this.runId = existingRunId || new Date().toISOString().replace(/[:.]/g, '-');
    this.krenkDir = path.join(projectDir, '.krenk');
    this.historyDir = path.join(this.krenkDir, 'history', this.runId);
    fs.mkdirSync(this.krenkDir, { recursive: true });
    fs.mkdirSync(this.historyDir, { recursive: true });
  }

  /** Save agent output to both memory and disk */
  async save(role: string, content: string): Promise<void> {
    this.memory.set(role, content);

    // Write to current run
    await fs.promises.writeFile(
      path.join(this.krenkDir, `${role}.md`),
      content,
      'utf-8'
    );

    // Write to history
    await fs.promises.writeFile(
      path.join(this.historyDir, `${role}.md`),
      content,
      'utf-8'
    );
  }

  /** Get a specific agent's output from memory */
  get(role: string): string | undefined {
    return this.memory.get(role);
  }

  /**
   * Build context string from all previous agents' outputs.
   * Includes outputs from all agents that ran before the given role.
   */
  buildContext(upToRole: string): string {
    const order = [
      'analyst',
      'strategist',
      'designer',
      'architect',
      'builder',
      'qa',
      'guardian',
      'sentinel',
      'security',
      'scribe',
      'devops',
    ];

    // Handle parallel builder roles like "builder-0", "builder-1"
    const baseRole = upToRole.replace(/-\d+$/, '');
    const idx = order.indexOf(baseRole);
    if (idx <= 0) return '';

    let ctx = '# Context from previous agents:\n';
    for (let i = 0; i < idx; i++) {
      const content = this.memory.get(order[i]);
      if (content) {
        ctx += `\n## Output from ${order[i].toUpperCase()}:\n${content}\n`;
      }
    }
    return ctx;
  }

  /** Save workflow state for resume capability */
  async saveState(state: Record<string, unknown>): Promise<void> {
    await fs.promises.writeFile(
      path.join(this.krenkDir, 'state.json'),
      JSON.stringify(state, null, 2),
      'utf-8'
    );
  }

  /** Load workflow state */
  async loadState(): Promise<Record<string, unknown> | null> {
    try {
      const data = await fs.promises.readFile(
        path.join(this.krenkDir, 'state.json'),
        'utf-8'
      );
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /** Get the .krenk directory path */
  getKrenkDir(): string {
    return this.krenkDir;
  }

  /** Get the run ID for this session */
  getRunId(): string {
    return this.runId;
  }

  /** Load all <role>.md files from a history dir into memory */
  async loadFromHistory(runId: string): Promise<void> {
    const histDir = path.join(this.krenkDir, 'history', runId);
    try {
      const files = await fs.promises.readdir(histDir);
      for (const file of files) {
        if (file.endsWith('.md')) {
          const role = file.replace(/\.md$/, '');
          const content = await fs.promises.readFile(
            path.join(histDir, file),
            'utf-8'
          );
          this.memory.set(role, content);
        }
      }
    } catch {
      // History dir may not exist for very old runs
    }
  }

  /** Save state.json to both .krenk/ and .krenk/history/<runId>/ */
  async saveStateToHistory(state: Record<string, unknown>): Promise<void> {
    const json = JSON.stringify(state, null, 2);
    await Promise.all([
      fs.promises.writeFile(
        path.join(this.krenkDir, 'state.json'),
        json,
        'utf-8'
      ),
      fs.promises.writeFile(
        path.join(this.historyDir, 'state.json'),
        json,
        'utf-8'
      ),
    ]);
  }

  /** Read state.json from a specific history dir */
  static async loadRunState(
    projectDir: string,
    runId: string
  ): Promise<Record<string, unknown> | null> {
    try {
      const data = await fs.promises.readFile(
        path.join(projectDir, '.krenk', 'history', runId, 'state.json'),
        'utf-8'
      );
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
}
