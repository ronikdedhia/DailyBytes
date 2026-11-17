import { executeNewsDataJob, executeAlphaVantageJob, executeCleanupJob, JobOutcome } from './news-pipeline.cron';
import { executeScheduledNewsletterJob } from './newsletter.cron';

/**
 * Scheduled jobs that external schedulers (QStash, GitHub Actions) can trigger.
 * All of them are safe to call more than once: pipelines dedupe by URL, cleanup
 * and the newsletter check their last run in the database, and each job holds
 * an in-process lock while running.
 */
export const SCHEDULED_JOBS: Record<string, () => Promise<JobOutcome>> = {
  'news-data': () => executeNewsDataJob(),
  'alpha-vantage': () => executeAlphaVantageJob(),
  cleanup: () => executeCleanupJob(),
  newsletter: () => executeScheduledNewsletterJob(),
};
