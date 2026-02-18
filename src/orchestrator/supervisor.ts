import { EventEmitter } from 'node:events';
import { execSync, spawn as spawnProcess } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { logger } from '../utils/logger.js';

const isWindows = process.platform === 'win32';

export interface ProcessStats {
  pid: number;
  role: string;
  memoryMB: number;
  cpuPercent: number;
  uptime: number; // seconds since spawn
  lastOutputAge: number; // seconds since last output
  status: 'healthy' | 'warning' | 'critical';
}

export interface SupervisorLimits {
  /** Max memory per agent in MB (default: 512) */
  maxMemoryMB: number;
  /** Max time per agent in seconds (default: 600 = 10 min) */
  maxTimeSeconds: number;
  /** Seconds of no output before warning (default: 60) */
  hungWarningSeconds: number;
  /** Seconds of no output before kill (default: 180) */
  hungKillSeconds: number;
  /** Poll interval in ms (default: 5000) */
  pollIntervalMs: number;
}

const DEFAULT_LIMITS: SupervisorLimits = {
  maxMemoryMB: 512,
  maxTimeSeconds: 900,
  hungWarningSeconds: 180,
  hungKillSeconds: 480,
  pollIntervalMs: 5000,
};

interface TrackedProcess {
  pid: number;
  role: string;
  child: ChildProcess;
  spawnedAt: number;
  lastOutputAt: number;
  warned: boolean;
}

/**
 * ProcessSupervisor — the top-level watchdog for all spawned agent processes.
 *
 * Monitors memory, CPU, timeouts, and hung processes.
 * Kills anything that goes out of bounds.
 *
 * Events emitted:
 *   'stats'   → ProcessStats[]  (every poll cycle)
 *   'warning' → { role, reason }
 *   'killed'  → { role, pid, reason }
 */
export class ProcessSupervisor extends EventEmitter {
  private tracked: Map<number, TrackedProcess> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private limits: SupervisorLimits;

  constructor(limits?: Partial<SupervisorLimits>) {
    super();
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /**
   * Start watching a spawned child process.
   */
  track(role: string, child: ChildProcess): void {
    if (!child.pid) return;

    const entry: TrackedProcess = {
      pid: child.pid,
      role,
      child,
      spawnedAt: Date.now(),
      lastOutputAt: Date.now(),
      warned: false,
    };

    this.tracked.set(child.pid, entry);

    // Listen for output to track "last activity"
    child.stdout?.on('data', () => {
      entry.lastOutputAt = Date.now();
    });
    child.stderr?.on('data', () => {
      entry.lastOutputAt = Date.now();
    });

    // Auto-untrack on exit
    child.on('close', () => {
      this.tracked.delete(entry.pid);
    });
    child.on('error', () => {
      this.tracked.delete(entry.pid);
    });

    // Start polling if this is the first tracked process
    if (!this.pollTimer) {
      this.startPolling();
    }
  }

  /**
   * Manually refresh output timestamp for a role (e.g. from engine events).
   */
  heartbeat(role: string): void {
    for (const entry of this.tracked.values()) {
      if (entry.role === role) {
        entry.lastOutputAt = Date.now();
      }
    }
  }

  /**
   * Get current stats for all tracked processes.
   */
  getStats(): ProcessStats[] {
    const pids = Array.from(this.tracked.keys());
    if (pids.length === 0) return [];

    const resourceMap = this.pollResources(pids);
    const now = Date.now();
    const stats: ProcessStats[] = [];

    for (const entry of this.tracked.values()) {
      const res = resourceMap.get(entry.pid);
      const uptime = Math.round((now - entry.spawnedAt) / 1000);
      const lastOutputAge = Math.round((now - entry.lastOutputAt) / 1000);
      const memoryMB = res?.memoryMB ?? 0;
      const cpuPercent = res?.cpuPercent ?? 0;

      let status: ProcessStats['status'] = 'healthy';
      if (
        memoryMB > this.limits.maxMemoryMB * 0.8 ||
        uptime > this.limits.maxTimeSeconds * 0.8 ||
        lastOutputAge > this.limits.hungWarningSeconds
      ) {
        status = 'warning';
      }
      if (
        memoryMB > this.limits.maxMemoryMB ||
        uptime > this.limits.maxTimeSeconds ||
        lastOutputAge > this.limits.hungKillSeconds
      ) {
        status = 'critical';
      }

      stats.push({
        pid: entry.pid,
        role: entry.role,
        memoryMB,
        cpuPercent,
        uptime,
        lastOutputAge,
        status,
      });
    }

    return stats;
  }

  /**
   * Stop supervising. Clears poll timer but does NOT kill tracked processes.
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Stop supervising and kill ALL tracked processes immediately.
   */
  killAll(): void {
    this.stop();
    for (const entry of this.tracked.values()) {
      this.killProcess(entry, 'supervisor shutdown');
    }
    this.tracked.clear();
  }

  /**
   * Get number of active tracked processes.
   */
  get activeCount(): number {
    return this.tracked.size;
  }

  // ── Private ──────────────────────────────────────────────

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      this.runChecks();
    }, this.limits.pollIntervalMs);

    // Don't keep process alive just for this timer
    this.pollTimer.unref();
  }

  private runChecks(): void {
    if (this.tracked.size === 0) {
      this.stop();
      return;
    }

    const stats = this.getStats();
    this.emit('stats', stats);

    for (const stat of stats) {
      const entry = this.tracked.get(stat.pid);
      if (!entry) continue;

      // Memory limit exceeded
      if (stat.memoryMB > this.limits.maxMemoryMB) {
        this.killProcess(entry, `memory limit exceeded (${Math.round(stat.memoryMB)}MB > ${this.limits.maxMemoryMB}MB)`);
        continue;
      }

      // Timeout exceeded
      if (stat.uptime > this.limits.maxTimeSeconds) {
        this.killProcess(entry, `timeout exceeded (${stat.uptime}s > ${this.limits.maxTimeSeconds}s)`);
        continue;
      }

      // Hung process — no output for too long
      if (stat.lastOutputAge > this.limits.hungKillSeconds) {
        this.killProcess(entry, `no output for ${stat.lastOutputAge}s (limit: ${this.limits.hungKillSeconds}s)`);
        continue;
      }

      // Hung warning
      if (stat.lastOutputAge > this.limits.hungWarningSeconds && !entry.warned) {
        entry.warned = true;
        this.emit('warning', {
          role: entry.role,
          pid: entry.pid,
          reason: `no output for ${stat.lastOutputAge}s`,
          stats: stat,
        });
      }

      // Memory warning (80% of limit)
      if (stat.memoryMB > this.limits.maxMemoryMB * 0.8 && !entry.warned) {
        entry.warned = true;
        this.emit('warning', {
          role: entry.role,
          pid: entry.pid,
          reason: `high memory usage (${Math.round(stat.memoryMB)}MB)`,
          stats: stat,
        });
      }

      // Time warning (80% of limit)
      if (stat.uptime > this.limits.maxTimeSeconds * 0.8 && !entry.warned) {
        entry.warned = true;
        this.emit('warning', {
          role: entry.role,
          pid: entry.pid,
          reason: `approaching timeout (${stat.uptime}s / ${this.limits.maxTimeSeconds}s)`,
          stats: stat,
        });
      }
    }
  }

  /**
   * Use `ps` to get memory (RSS) and CPU% for a list of PIDs.
   * Works on macOS and Linux.
   */
  private pollResources(pids: number[]): Map<number, { memoryMB: number; cpuPercent: number }> {
    const result = new Map<number, { memoryMB: number; cpuPercent: number }>();

    try {
      if (isWindows) {
        // Windows: use wmic to get memory for each process
        const pidFilter = pids.map(p => `ProcessId=${p}`).join(' or ');
        const output = execSync(
          `wmic process where "${pidFilter}" get ProcessId,WorkingSetSize /format:csv 2>nul`,
          { encoding: 'utf-8', timeout: 5000 }
        );
        for (const line of output.trim().split('\n')) {
          const parts = line.trim().split(',');
          // CSV format: Node,ProcessId,WorkingSetSize
          if (parts.length >= 3) {
            const pid = parseInt(parts[1], 10);
            const bytes = parseInt(parts[2], 10);
            if (!isNaN(pid) && !isNaN(bytes)) {
              result.set(pid, {
                memoryMB: Math.round((bytes / 1024 / 1024) * 10) / 10,
                cpuPercent: 0, // wmic cpu% is unreliable for snapshots
              });
            }
          }
        }
      } else {
        // Unix: ps -o pid=,rss=,pcpu= -p <pid1>,<pid2>,...
        // rss is in KB on both macOS and Linux
        const pidList = pids.join(',');
        const output = execSync(`ps -o pid=,rss=,pcpu= -p ${pidList} 2>/dev/null`, {
          encoding: 'utf-8',
          timeout: 3000,
        });

        for (const line of output.trim().split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 3) {
            const pid = parseInt(parts[0], 10);
            const rssKB = parseInt(parts[1], 10);
            const cpu = parseFloat(parts[2]);
            if (!isNaN(pid) && !isNaN(rssKB)) {
              result.set(pid, {
                memoryMB: Math.round((rssKB / 1024) * 10) / 10,
                cpuPercent: isNaN(cpu) ? 0 : cpu,
              });
            }
          }
        }
      }
    } catch {
      // ps/wmic failed — process may have exited between check and poll
    }

    return result;
  }

  private killProcess(entry: TrackedProcess, reason: string): void {
    logger.info(`Supervisor killing ${entry.role} (PID ${entry.pid}): ${reason}`);

    this.emit('killed', {
      role: entry.role,
      pid: entry.pid,
      reason,
    });

    if (isWindows) {
      try {
        spawnProcess('taskkill', ['/pid', String(entry.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        try { entry.child.kill(); } catch { /* already dead */ }
      }
    } else {
      // Kill the process group
      try {
        process.kill(-entry.pid, 'SIGTERM');
      } catch {
        try { entry.child.kill('SIGTERM'); } catch { /* already dead */ }
      }

      // Force kill after 3s
      setTimeout(() => {
        try { process.kill(-entry.pid, 'SIGKILL'); } catch { /* already dead */ }
        try { entry.child.kill('SIGKILL'); } catch { /* already dead */ }
      }, 3000).unref();
    }

    this.tracked.delete(entry.pid);
  }
}
