import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface SpawnOptions {
  role: string;
  prompt: string;
  systemPrompt: string;
  cwd: string;
  maxTurns?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  context?: string;
}

export interface AgentResult {
  role: string;
  output: string;
  cost?: { input: number; output: number };
  duration: number;
  success: boolean;
  exitCode: number | null;
}

export interface AgentEmitter extends EventEmitter {
  child?: ChildProcess;
}

// ── Global PID tracker ─────────────────────────────────────
// Every spawned child process is tracked here so we can kill them all on Ctrl+C

const activeChildren: Set<ChildProcess> = new Set();

/**
 * Kill ALL active agent processes immediately.
 * Sends SIGTERM to the entire process group, then SIGKILL after 3s.
 */
export function killAllAgents(): void {
  for (const child of activeChildren) {
    forceKillChild(child);
  }
  activeChildren.clear();
}

function forceKillChild(child: ChildProcess): void {
  if (child.killed) return;

  // Try killing the process group first (kills child + anything it spawned)
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Process group kill failed, fall back to direct kill
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
    }
  } else {
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
  }

  // Force kill after 3 seconds if still alive
  setTimeout(() => {
    if (!child.killed && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already dead */ }
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }
  }, 3000).unref();
}

export function spawnClaudeAgent(opts: SpawnOptions): AgentEmitter {
  const emitter: AgentEmitter = new EventEmitter();
  const env = { ...process.env };

  // Remove nested session blockers so Claude Code doesn't refuse to spawn
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  // Build the full prompt with accumulated context from prior agents
  const fullPrompt = opts.context
    ? `${opts.context}\n\n---\n\nYour current task:\n${opts.prompt}`
    : opts.prompt;

  const args = [
    '-p', fullPrompt,
    '--output-format', 'stream-json',
    '--max-turns', String(opts.maxTurns || 50),
    '--verbose',
    '--dangerously-skip-permissions',
  ];

  if (opts.systemPrompt) {
    args.push('--system-prompt', opts.systemPrompt);
  }

  if (opts.allowedTools?.length) {
    args.push('--allowedTools', ...opts.allowedTools);
  }

  if (opts.disallowedTools?.length) {
    args.push('--disallowedTools', ...opts.disallowedTools);
  }

  const startTime = Date.now();

  const child = spawn('claude', args, {
    env,
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // Create process group so we can kill the whole tree
  });

  emitter.child = child;
  activeChildren.add(child);

  let stdout = '';
  let stderr = '';
  let stdoutLineBuffer = '';

  // Line-buffered stdout: stream-json emits one JSON object per line.
  // Raw pipe chunks can split across line boundaries, so we buffer
  // and only emit complete lines. This lets the renderer parse each
  // event as valid JSON.
  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stdout += text;
    stdoutLineBuffer += text;

    const lines = stdoutLineBuffer.split('\n');
    // Last element is either '' (if chunk ended with \n) or a partial line
    stdoutLineBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        emitter.emit('data', trimmed);
      }
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stderr += text;
    emitter.emit('stderr', text);
  });

  child.on('close', (code) => {
    activeChildren.delete(child);
    const duration = Math.round((Date.now() - startTime) / 1000);
    const result: AgentResult = {
      role: opts.role,
      output: stdout,
      duration,
      success: code === 0,
      exitCode: code,
    };

    // Parse stream-json output: newline-delimited JSON events.
    // Look for the final {"type":"result",...} line to extract the result text and cost.
    const lines = stdout.trim().split('\n');
    let foundResult = false;

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);

        // stream-json result event
        if (parsed.type === 'result') {
          if (parsed.result) {
            result.output = parsed.result;
          }
          if (parsed.cost_usd !== undefined) {
            result.cost = { input: parsed.cost_usd, output: 0 };
          }
          foundResult = true;
          break;
        }
      } catch {
        // Not valid JSON line, skip
      }
    }

    // Fallback: try parsing as single JSON (in case format changes)
    if (!foundResult) {
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.result) {
          result.output = parsed.result;
        }
        if (parsed.cost_usd !== undefined) {
          result.cost = { input: parsed.cost_usd, output: 0 };
        }
      } catch {
        // Not valid JSON, use raw output
      }
    }

    emitter.emit('done', result);
  });

  child.on('error', (err) => {
    activeChildren.delete(child);
    emitter.emit('error', err);
  });

  // Emit spawned event on next tick so listeners can attach
  process.nextTick(() => {
    emitter.emit('spawned', child.pid);
  });

  return emitter;
}

/**
 * Wraps spawnClaudeAgent in a Promise for easier sequential use
 */
export function runAgent(opts: SpawnOptions): Promise<AgentResult> {
  return new Promise((resolve, reject) => {
    const emitter = spawnClaudeAgent(opts);

    emitter.on('done', (result: AgentResult) => {
      resolve(result);
    });

    emitter.on('error', (err: Error) => {
      reject(err);
    });
  });
}

/**
 * Kill a spawned agent process
 */
export function killAgent(emitter: AgentEmitter): void {
  if (emitter.child) {
    forceKillChild(emitter.child);
    activeChildren.delete(emitter.child);
  }
}
