import axios from 'axios';
import { rawClient } from '../db/client';
import { logger } from '../utils/logger';
import { feedHealthService, FeedHealthMap } from './feed-health.service';

export const FEED_FAIL_DAYS_ALERT = 3;

export interface RunRow {
  source: string;
  status: string;
  saved: number;
  errors: number;
  startedAt: string;
}

export interface HealthReport {
  ok: boolean;
  problems: string[];
  savedLast24h: number;
  runsLast24h: number;
}

/** Pure: what is wrong, given the last 24h of runs and the feed-health map. */
export function assessHealth(runs: RunRow[], feeds: FeedHealthMap): HealthReport {
  const problems: string[] = [];
  const saved = runs.reduce((n, r) => n + (r.saved || 0), 0);
  if (runs.length === 0) {
    problems.push('No pipeline ran in the last 24 hours. Is the scheduler waking the backend?');
  } else if (saved === 0) {
    problems.push(`${runs.length} pipeline run(s) in the last 24 hours saved 0 articles.`);
  }
  const failedBySource = new Map<string, number>();
  for (const r of runs) if (r.status === 'failed') failedBySource.set(r.source, (failedBySource.get(r.source) ?? 0) + 1);
  for (const [source, n] of failedBySource) problems.push(`${source}: ${n} failed run(s) in the last 24 hours.`);
  for (const [url, f] of Object.entries(feeds)) {
    if (f.failDays >= FEED_FAIL_DAYS_ALERT) {
      problems.push(`Feed ${f.outlet} has failed ${f.failDays} days in a row (${f.lastError ?? 'error'}): ${url}`);
    }
  }
  return { ok: problems.length === 0, problems, savedLast24h: saved, runsLast24h: runs.length };
}

export function adminChatId(): string | null {
  return process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID || null;
}

/** Send a message to the admin's own chat through the channel bot (TELEGRAM_ACCESS_TOKEN). */
export async function sendAdminMessage(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_ACCESS_TOKEN;
  const chatId = adminChatId();
  if (!token || !chatId) return false;
  const { data } = await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId, text, link_preview_options: { is_disabled: true },
  }, { timeout: 15_000, validateStatus: () => true });
  if (!data?.ok) logger.warn(`⚠ [health] admin message failed: ${data?.description}`);
  return Boolean(data?.ok);
}

class HealthCheckService {
  async lastDayRuns(now: Date): Promise<RunRow[]> {
    const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
    const r = await rawClient.execute({
      sql: 'SELECT source, status, saved, errors, started_at FROM pipeline_runs WHERE started_at >= ? ORDER BY started_at',
      args: [since],
    });
    return r.rows.map((x: any) => ({ source: String(x.source), status: String(x.status), saved: Number(x.saved), errors: Number(x.errors), startedAt: String(x.started_at) }));
  }

  /** Check, and message the admin only if something is wrong. */
  async run(now: Date = new Date()): Promise<HealthReport & { alerted: boolean }> {
    const report = assessHealth(await this.lastDayRuns(now), await feedHealthService.get());
    let alerted = false;
    if (!report.ok) {
      logger.warn(`🩺 [health] ${report.problems.length} problem(s): ${report.problems.join(' | ')}`);
      alerted = await sendAdminMessage(`⚠️ Daily Bytes health check\n\n${report.problems.map((p) => `• ${p}`).join('\n')}\n\nSaved in the last 24h: ${report.savedLast24h} articles across ${report.runsLast24h} runs.`);
      if (!alerted) logger.warn('⚠ [health] no admin chat configured (TELEGRAM_ADMIN_CHAT_ID) or send failed');
    } else {
      logger.info(`🩺 [health] OK: ${report.savedLast24h} articles saved in ${report.runsLast24h} runs`);
    }
    return { ...report, alerted };
  }
}

export const healthCheckService = new HealthCheckService();
