import chalk from 'chalk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private level: LogLevel = 'info';
  private quiet: boolean = false;

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setQuiet(quiet: boolean): void {
    this.quiet = quiet;
  }

  debug(msg: string, ...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      console.error(chalk.gray(`[DEBUG] ${msg}`), ...args);
    }
  }

  info(msg: string, ...args: unknown[]): void {
    if (this.shouldLog('info')) {
      console.error(chalk.blue(`[INFO] ${msg}`), ...args);
    }
  }

  warn(msg: string, ...args: unknown[]): void {
    if (this.shouldLog('warn')) {
      console.error(chalk.yellow(`[WARN] ${msg}`), ...args);
    }
  }

  error(msg: string, ...args: unknown[]): void {
    if (this.shouldLog('error')) {
      console.error(chalk.red(`[ERROR] ${msg}`), ...args);
    }
  }

  success(msg: string, ...args: unknown[]): void {
    if (this.shouldLog('info')) {
      console.error(chalk.green(`[OK] ${msg}`), ...args);
    }
  }

  private shouldLog(level: LogLevel): boolean {
    if (this.quiet) return level === 'error';
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }
}

export const logger = new Logger();
