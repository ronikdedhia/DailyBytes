import { logger } from '../utils/logger';
import { newsletterService } from '../services/newsletter.service';
import { jobStateService } from '../services/job-state.service';
import { runExclusive } from '../lib/job-lock';
import type { JobOutcome } from './news-pipeline.cron';

/**
 * Parse time string in HH:MM format (e.g., "08:00")
 * Returns cron expression for that time daily
 */
export function getNewsletterCronExpression(timeString: string): string {
  const [hours, minutes] = timeString.split(':').map(Number);
  if (isNaN(hours) || isNaN(minutes)) {
    logger.warn(`Invalid time format: ${timeString}, using default 08:00`);
    return '0 8 * * *';
  }
  return `${minutes} ${hours} * * *`;
}

export const NEWSLETTER_STATE_KEY = 'newsletter:last_sent_date';

/**
 * Execute newsletter send with error handling
 */
async function executeNewsletterJob(): Promise<JobOutcome> {
  const jobStartTime = new Date().toISOString();

  try {
    logger.info(`🔄 Newsletter job started at ${jobStartTime}`);

    const result = await newsletterService.sendNewsletterToAll();

    logger.info(`✅ Newsletter job completed`);
    logger.info(`📈 Results: ${result.sent} sent, ${result.failed} failed`);
    return { status: 'completed', result };
  } catch (error: any) {
    logger.error(`❌ Newsletter job failed: ${error.message}`);
    return { status: 'failed', error: error.message };
  }
}

/**
 * Scheduled send (node-cron and QStash both call this). Sends at most once per
 * UTC day, so the two schedulers firing together don't email users twice.
 */
export async function executeScheduledNewsletterJob(now: Date = new Date()): Promise<JobOutcome> {
  const today = now.toISOString().slice(0, 10);
  let outcome: JobOutcome = { status: 'skipped' };
  await runExclusive('newsletter', async () => {
    try {
      const lastSent = await jobStateService.get(NEWSLETTER_STATE_KEY);
      if (lastSent === today) {
        logger.info(`⏭ Newsletter already sent today (${today}) — skipping`);
        outcome = { status: 'skipped' };
        return;
      }
      // Mark before sending: a crash mid-send should not re-email users who already got it.
      await jobStateService.set(NEWSLETTER_STATE_KEY, today);
    } catch (error: any) {
      logger.error(`❌ Newsletter job failed reading send state: ${error.message}`);
      outcome = { status: 'failed', error: error.message };
      return;
    }
    outcome = await executeNewsletterJob();
  });
  return outcome;
}

/**
 * Manual trigger for testing (always sends)
 */
export async function triggerNewsletterManually() {
  logger.info('🔄 Manual trigger: Newsletter');
  await runExclusive('newsletter', async () => { await executeNewsletterJob(); });
}
