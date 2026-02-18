import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isWindows = process.platform === 'win32';

/**
 * Resolve the full path to the `claude` binary.
 * On Windows, `spawn('claude')` fails with ENOENT because it can't
 * find `claude.cmd`. We use `where` / `which` to get the real path.
 */
let resolvedClaudePath: string | null = null;
function getClaudeBinary(): string {
  if (resolvedClaudePath) return resolvedClaudePath;
  try {
    const cmd = isWindows ? 'where claude' : 'which claude';
    const result = execFileSync(isWindows ? 'cmd' : 'sh',
      isWindows ? ['/c', cmd] : ['-c', cmd],
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    // `where` on Windows can return multiple lines, take the first
    resolvedClaudePath = result.split('\n')[0].trim();
    return resolvedClaudePath;
  } catch {
    // Fallback — hope it's in PATH
    return 'claude';
  }
}

export interface SpawnOptions {
  role: string;
  prompt: string;
  systemPrompt: string;
  cwd: string;
  maxTurns?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  context?: string;
  model?: string;
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

  if (isWindows) {
    // Windows: use taskkill to kill process tree
    if (child.pid) {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        try { child.kill(); } catch { /* already dead */ }
      }
    } else {
      try { child.kill(); } catch { /* already dead */ }
    }
  } else {
    // Unix: kill process group
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
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

  // On Windows, long prompts with special chars break shell argument parsing.
  // Write prompt and system prompt to temp files and read via stdin / flag.
  const tempFiles: string[] = [];
  let promptArg: string[];
  const tempDir = join(tmpdir(), 'krenk-prompts');
  mkdirSync(tempDir, { recursive: true });

  if (isWindows) {
    const promptFile = join(tempDir, `prompt-${opts.role}-${Date.now()}.txt`);
    writeFileSync(promptFile, fullPrompt, 'utf-8');
    promptArg = ['-p', `@${promptFile}`];
    tempFiles.push(promptFile);
  } else {
    promptArg = ['-p', fullPrompt];
  }

  const args = [
    ...promptArg,
    '--output-format', 'stream-json',
    '--max-turns', String(opts.maxTurns || 50),
    '--verbose',
    '--dangerously-skip-permissions',
  ];

  if (opts.model) {
    args.push('--model', opts.model);
  }

  if (opts.systemPrompt) {
    if (isWindows) {
      const sysFile = join(tempDir, `sys-${opts.role}-${Date.now()}.txt`);
      writeFileSync(sysFile, opts.systemPrompt, 'utf-8');
      args.push('--system-prompt', `@${sysFile}`);
      tempFiles.push(sysFile);
    } else {
      args.push('--system-prompt', opts.systemPrompt);
    }
  }

  if (opts.allowedTools?.length) {
    args.push('--allowedTools', ...opts.allowedTools);
  }

  if (opts.disallowedTools?.length) {
    args.push('--disallowedTools', ...opts.disallowedTools);
  }

  const claudeBin = getClaudeBinary();
  const startTime = Date.now();

  const child = spawn(claudeBin, args, {
    env,
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Unix: detached=true creates process group for clean tree kills
    ...(isWindows ? {} : { detached: true }),
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
    // Clean up temp files
    for (const f of tempFiles) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    const duration = Math.round((Date.now() - startTime) / 1000);

    // Log stderr on failure to help debug
    if (code !== 0 && stderr.trim()) {
      emitter.emit('data', JSON.stringify({
        type: 'system',
        message: `[${opts.role}] stderr: ${stderr.trim().slice(0, 500)}`,
      }));
    }

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
