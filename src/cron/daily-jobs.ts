import cron from 'node-cron';
import { logger } from '../utils/logger';
import { jobStateService } from '../services/job-state.service';
import { SCHEDULED_JOBS } from './jobs';
import type { JobOutcome } from './news-pipeline.cron';
import { getNewsletterCronExpression } from './newsletter.cron';

/**
 * Daily schedule in UTC. node-cron, GitHub Actions, QStash and Vercel cron all
 * aim at these times; whichever gets here first does the work.
 */
export function dailySchedule(): Array<{ job: string; utc: string }> {
  return [
    { job: 'newsletter', utc: process.env.NEWSLETTER_SEND_TIME || '06:30' }, // 12:00 PM IST
    { job: 'markets', utc: '07:30' },                                         //  1:00 PM IST
    { job: 'news-data', utc: '08:30' },                                       //  2:00 PM IST
    // Before the 08:45 Vercel wake-up, so one wake runs news-data, rss and the digest in order.
    { job: 'rss', utc: '08:35' },                                             //  2:05 PM IST
    { job: 'telegram-digest', utc: '08:40' },                                 //  2:10 PM IST
    { job: 'telegram-weekly', utc: '08:42' },                                 //  2:12 PM IST, sends on Sundays only
    { job: 'embed-backfill', utc: '08:44' },                                  //  2:14 PM IST
    { job: 'cleanup', utc: '12:30' },                                         //  6:00 PM IST
    // After every run of the day, before the 12:45 Vercel wake-up.
    { job: 'health-check', utc: '12:35' },                                    //  6:05 PM IST
  ];
}

export const dailyStateKey = (job: string) => `daily:${job}:last_run_date`;
const utcDate = (d: Date) => d.toISOString().slice(0, 10);

function scheduledAt(utc: string, now: Date): Date {
  const [h, m] = utc.split(':').map(Number);
  const at = new Date(now);
  at.setUTCHours(Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0, 0, 0);
  return at;
}

/**
 * Run a scheduled job at most once per UTC day. A run only counts once it
 * completes, so a failed run is retried by the next trigger the same day.
 */
export async function runDailyJob(job: string, now: Date = new Date()): Promise<JobOutcome> {
  const run = SCHEDULED_JOBS[job];
  if (!run) throw new Error(`Unknown job: ${job}`);
  const today = utcDate(now);
  if ((await jobStateService.get(dailyStateKey(job))) === today) {
    logger.info(`⏭ ${job} already ran today (${today})`);
    return { status: 'skipped' };
  }
  const outcome = await run();
  if (outcome.status === 'completed') {
    await jobStateService.set(dailyStateKey(job), today);
  }
  return outcome;
}

/**
 * Run every job whose time has passed today but which hasn't run yet.
 * Render's free tier sleeps, and in-process cron can't fire while asleep, so this
 * runs on boot (any request wakes the server) and every 15 minutes while awake.
 */
export async function catchUpMissedJobs(now: Date = new Date()): Promise<string[]> {
  const ran: string[] = [];
  const due = dailySchedule()
    .filter(({ utc }) => scheduledAt(utc, now) <= now)
    .sort((a, b) => a.utc.localeCompare(b.utc));
  for (const { job } of due) {
    try {
      if ((await jobStateService.get(dailyStateKey(job))) === utcDate(now)) continue;
      logger.info(`⏰ Catch-up: ${job} was due at ${scheduledAtLabel(job)} UTC and hasn't run today`);
      const outcome = await runDailyJob(job, now);
      if (outcome.status !== 'skipped') ran.push(job);
    } catch (error: any) {
      logger.error(`❌ Catch-up for ${job} failed: ${error.message}`);
    }
  }
  return ran;
}

function scheduledAtLabel(job: string): string {
  return dailySchedule().find((s) => s.job === job)?.utc ?? '?';
}

let catchUpRunning = false;

/** Start catch-up now and every 15 minutes. Never runs two catch-ups at once. */
export function startCatchUpLoop(intervalMs = 15 * 60 * 1000): NodeJS.Timeout {
  const tick = async () => {
    if (catchUpRunning) return;
    catchUpRunning = true;
    try {
      await catchUpMissedJobs();
    } finally {
      catchUpRunning = false;
    }
  };
  void tick();
  return setInterval(() => void tick(), intervalMs);
}

/** In-process schedules (only fire while the server is awake; see catchUpMissedJobs). */
export function initializeDailyCron() {
  for (const { job, utc } of dailySchedule()) {
    cron.schedule(getNewsletterCronExpression(utc), async () => {
      logger.info(`⏰ Cron triggered: ${job} (${utc} UTC)`);
      try {
        await runDailyJob(job);
      } catch (error: any) {
        logger.error(`❌ ${job} failed: ${error.message}`);
      }
    }, { timezone: 'Etc/UTC' });
    logger.info(`📅 ${job}: ${utc} UTC daily`);
  }
}
