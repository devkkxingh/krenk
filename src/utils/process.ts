import type { OrchestrationEngine } from '../orchestrator/engine.js';
import { killAllAgents } from '../agents/spawner.js';

/**
 * Set up graceful shutdown handlers to kill all child processes
 */
export function setupGracefulShutdown(
  engine: OrchestrationEngine,
  onCleanup?: () => void
): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) {
      // Second Ctrl+C → force exit immediately
      console.error('\nForce exit.');
      killAllAgents();
      process.exit(1);
    }

    shuttingDown = true;
    console.error(`\nReceived ${signal}, shutting down all agents...`);

    // Clean up UI (stop spinners etc)
    onCleanup?.();

    // Kill via engine (scheduler + registry + global)
    engine.shutdown();

    // Also kill globally in case engine missed anything
    killAllAgents();

    // Give processes 3s to die, then force exit
    setTimeout(() => {
      killAllAgents();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    }, 3000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Handle uncaught errors
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err.message);
    onCleanup?.();
    engine.shutdown();
    killAllAgents();
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    onCleanup?.();
    engine.shutdown();
    killAllAgents();
    process.exit(1);
  });
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h ${remainMins}m ${secs}s`;
}

/**
 * Format cost in USD
 */
export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
