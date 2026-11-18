import { logger } from '../utils/logger';
import { pipelineService } from '../services/pipeline.service';
import { cleanupService } from '../services/cleanup.service';
import { jobStateService } from '../services/job-state.service';
import { runExclusive } from '../lib/job-lock';

export const CLEANUP_INTERVAL_DAYS = 15;
export const CLEANUP_MAX_AGE_DAYS = 30;
export const CLEANUP_STATE_KEY = 'cleanup:last_run_at';

const DAY_MS = 1000 * 60 * 60 * 24;

export type JobOutcome =
  | { status: 'completed'; result?: unknown }
  | { status: 'skipped' }
  | { status: 'failed'; error: string; result?: unknown };

/** A run that saved nothing and only hit errors (e.g. the news API rejected the request) counts as failed. */
export function pipelineOutcome(result: { saved: number; errors: number }): JobOutcome {
  return result.saved === 0 && result.errors > 0
    ? { status: 'failed', error: `no articles saved, ${result.errors} error(s)`, result } as JobOutcome
    : { status: 'completed', result };
}

/**
 * Execute NewsData pipeline
 */
export async function executeNewsDataJob(): Promise<JobOutcome> {
  let outcome: JobOutcome = { status: 'skipped' };
  await runExclusive('newsdata-pipeline', async () => {
    try {
      logger.info('🔄 NewsData pipeline job started');
      const result = await pipelineService.executeNewsDataPipeline();
      outcome = pipelineOutcome(result);
      logger.info(`✅ NewsData done: ${result.processed} processed, ${result.saved} saved, ${result.telegramSent} Telegram sent, ${result.errors} errors`);
    } catch (error: any) {
      logger.error(`❌ NewsData pipeline job failed: ${error.message}`);
      outcome = { status: 'failed', error: error.message };
    }
  });
  return outcome;
}

/**
 * Execute the RSS pipeline (free Indian outlet feeds)
 */
export async function executeRssJob(): Promise<JobOutcome> {
  let outcome: JobOutcome = { status: 'skipped' };
  await runExclusive('rss-pipeline', async () => {
    try {
      logger.info('🔄 RSS pipeline job started');
      const result = await pipelineService.executeRssPipeline();
      outcome = pipelineOutcome(result);
      logger.info(`✅ RSS done: ${result.processed} processed, ${result.saved} saved, ${result.telegramSent} Telegram sent, ${result.errors} errors`);
    } catch (error: any) {
      logger.error(`❌ RSS pipeline job failed: ${error.message}`);
      outcome = { status: 'failed', error: error.message };
    }
  });
  return outcome;
}

/**
 * Execute Alpha Vantage pipeline
 */
export async function executeAlphaVantageJob(): Promise<JobOutcome> {
  let outcome: JobOutcome = { status: 'skipped' };
  await runExclusive('alphavantage-pipeline', async () => {
    try {
      logger.info('🔄 Alpha Vantage pipeline job started');
      const result = await pipelineService.executeAlphaVantagePipeline();
      outcome = pipelineOutcome(result);
      logger.info(`✅ Alpha Vantage done: ${result.processed} processed, ${result.saved} saved, ${result.telegramSent} Telegram sent, ${result.errors} errors`);
    } catch (error: any) {
      logger.error(`❌ Alpha Vantage pipeline job failed: ${error.message}`);
      outcome = { status: 'failed', error: error.message };
    }
  });
  return outcome;
}

export type CleanupDecision = 'initialize' | 'run' | 'skip';

/**
 * Pure decision for the cleanup job. With no recorded run, the schedule is
 * initialised (not run), so the first deletion happens one interval later.
 */
export function decideCleanup(lastRunAt: Date | null, now: Date, intervalDays = CLEANUP_INTERVAL_DAYS): CleanupDecision {
  if (!lastRunAt || Number.isNaN(lastRunAt.getTime())) return 'initialize';
  const daysSince = Math.floor((now.getTime() - lastRunAt.getTime()) / DAY_MS);
  return daysSince >= intervalDays ? 'run' : 'skip';
}

/**
 * Delete articles older than CLEANUP_MAX_AGE_DAYS, at most once every
 * CLEANUP_INTERVAL_DAYS. The last-run time is stored in the database so the
 * interval survives restarts.
 */
export async function executeCleanupJob(now: Date = new Date()): Promise<JobOutcome> {
  let outcome: JobOutcome = { status: 'skipped' };
  await runExclusive('cleanup', async () => {
    try {
      const stored = await jobStateService.get(CLEANUP_STATE_KEY);
      const lastRunAt = stored ? new Date(stored) : null;
      const decision = decideCleanup(lastRunAt, now);

      if (decision === 'initialize') {
        await jobStateService.set(CLEANUP_STATE_KEY, now.toISOString());
        logger.info(`📅 No previous cleanup recorded — first cleanup will run in ${CLEANUP_INTERVAL_DAYS} days`);
        outcome = { status: 'completed', result: { decision } };
        return;
      }

      if (decision === 'skip') {
        logger.debug(`⏭ Cleanup skipped: last run ${lastRunAt!.toISOString()} (interval ${CLEANUP_INTERVAL_DAYS} days)`);
        outcome = { status: 'completed', result: { decision } };
        return;
      }

      logger.info(`🗑 Cleanup job started (last run ${lastRunAt!.toISOString()})`);
      const result = await cleanupService.deleteOldArticles(CLEANUP_MAX_AGE_DAYS);
      await jobStateService.set(CLEANUP_STATE_KEY, now.toISOString());
      logger.info(`✅ Cleanup job completed: ${result.deleted} articles deleted`);
      outcome = { status: 'completed', result: { decision, deleted: result.deleted } };
    } catch (error: any) {
      logger.error(`❌ Cleanup job failed: ${error.message}`);
      outcome = { status: 'failed', error: error.message };
    }
  });
  return outcome;
}

/**
 * Manual trigger for testing (optional)
 */
export async function triggerNewsPipelineManually() {
  logger.info('🔄 Manual trigger: News pipeline');
  await runExclusive('newsdata-pipeline', async () => {
    try {
      const result = await pipelineService.executeNewsDataPipeline({ fresh: true });
      logger.info(`✅ Manual trigger done: ${result.processed} processed, ${result.saved} saved, ${result.errors} errors`);
    } catch (error: any) {
      logger.error(`❌ Manual trigger failed: ${error.message}`);
    }
  });
}
