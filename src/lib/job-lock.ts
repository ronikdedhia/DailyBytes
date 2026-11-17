import { logger } from '../utils/logger';

const running = new Set<string>();

/**
 * Runs `fn` unless a job with the same name is already running in this process.
 * node-cron and QStash fire at the same times, so without this the same
 * pipeline could run twice concurrently. Returns false if the run was skipped.
 */
export async function runExclusive(name: string, fn: () => Promise<void>): Promise<boolean> {
  if (running.has(name)) {
    logger.warn(`⏭ ${name} already running — skipping duplicate trigger`);
    return false;
  }
  running.add(name);
  try {
    await fn();
    return true;
  } finally {
    running.delete(name);
  }
}

export function isRunning(name: string): boolean {
  return running.has(name);
}
