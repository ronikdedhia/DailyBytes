import { Client } from '@upstash/qstash';
import { logger } from '../utils/logger';
import { dailyRunTime } from './daily-jobs';

async function registerSchedule(qstash: Client, destination: string, cron: string, label: string) {
  const existing = await qstash.schedules.list();
  if (existing.some((s: { destination: string }) => s.destination === destination)) return;
  await qstash.schedules.create({ destination, cron });
  logger.info(`✅ [qstash] schedule registered → ${label} (${destination})`);
}

/**
 * Registers external QStash schedules that hit this service over HTTP —
 * unlike node-cron, these fire even if the process was asleep/restarted,
 * as long as QSTASH_TOKEN + BACKEND_PUBLIC_URL are set.
 */
export async function initializeQStashSchedules() {
  const token = process.env.QSTASH_TOKEN;
  const backendUrl = process.env.BACKEND_PUBLIC_URL?.replace(/\/+$/, '');
  if (!token || !backendUrl) {
    logger.info('[qstash] QSTASH_TOKEN or BACKEND_PUBLIC_URL not set — relying on node-cron only');
    return;
  }

  const qstash = new Client({ token });

  try {
    const [h, m] = dailyRunTime().split(':').map(Number);
    await registerSchedule(qstash, `${backendUrl}/api/qstash/daily`, `${m} ${h} * * *`, `Daily run — ${dailyRunTime()} UTC`);
  } catch (error: any) {
    logger.error(`❌ [qstash] schedule registration failed: ${error.message}`);
  }
}
