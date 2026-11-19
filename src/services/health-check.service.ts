import axios from 'axios';
import { rawClient } from '../db/client';
import { logger } from '../utils/logger';
import { feedHealthService, FeedHealthMap } from './feed-health.service';
import { config } from '../config';

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

export interface ServiceCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Brevo, checked from the server itself (Brevo's IP allow-list blocks other
 * machines): key accepted, sender verified, email credits left.
 */
export async function checkBrevo(): Promise<ServiceCheck> {
  const key = process.env.BREVO_API_KEY;
  const from = (process.env.BREVO_FROM_EMAIL || '').toLowerCase();
  if (!key) return { name: 'brevo', ok: false, detail: 'BREVO_API_KEY is not set' };
  const get = (path: string) => axios.get(`https://api.brevo.com/v3${path}`, { headers: { 'api-key': key }, timeout: 15_000, validateStatus: () => true });
  const account = await get('/account');
  if (account.status !== 200) {
    return { name: 'brevo', ok: false, detail: `account check HTTP ${account.status}: ${String(account.data?.message ?? '').slice(0, 200)}` };
  }
  const plans: Array<{ type?: string; credits?: number; creditsType?: string }> = account.data?.plan ?? [];
  const emailCredits = plans.filter((p) => p.creditsType === 'sendLimit' || p.type === 'free' || p.type === 'payAsYouGo')
    .reduce((n, p) => n + (Number(p.credits) || 0), 0);
  const senders = await get('/senders');
  const sender = (senders.data?.senders ?? []).find((x: any) => String(x.email).toLowerCase() === from);
  const problems: string[] = [];
  if (!from) problems.push('BREVO_FROM_EMAIL is not set');
  else if (!sender) problems.push(`sender ${from} is not in the Brevo account`);
  else if (!sender.active) problems.push(`sender ${from} is not verified`);
  if (plans.length && emailCredits <= 0) problems.push('no email credits left');
  return {
    name: 'brevo',
    ok: problems.length === 0,
    detail: problems.length ? problems.join('; ') : `OK: ${account.data?.email}, sender ${from} verified, ${emailCredits} email credits`,
  };
}

/** The configured Groq model answers. */
export async function checkGroq(): Promise<ServiceCheck> {
  const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
    model: config.groq.model, max_tokens: 3, messages: [{ role: 'user', content: 'Reply with OK' }],
  }, { headers: { Authorization: `Bearer ${config.groq.apiKey}` }, timeout: 20_000, validateStatus: () => true });
  return res.status === 200
    ? { name: 'groq', ok: true, detail: `OK: ${config.groq.model}` }
    : { name: 'groq', ok: false, detail: `${config.groq.model}: HTTP ${res.status} ${String(res.data?.error?.message ?? '').slice(0, 200)}` };
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
  async run(now: Date = new Date()): Promise<HealthReport & { alerted: boolean; services: ServiceCheck[] }> {
    const report = assessHealth(await this.lastDayRuns(now), await feedHealthService.get());
    const services = await Promise.all([checkBrevo(), checkGroq()].map((p) =>
      p.catch((err: any) => ({ name: 'check', ok: false, detail: String(err.message ?? err) }))));
    for (const svc of services) {
      if (!svc.ok) report.problems.push(`${svc.name}: ${svc.detail}`);
    }
    report.ok = report.problems.length === 0;
    let alerted = false;
    if (!report.ok) {
      logger.warn(`🩺 [health] ${report.problems.length} problem(s): ${report.problems.join(' | ')}`);
      alerted = await sendAdminMessage(`⚠️ Daily Bytes health check\n\n${report.problems.map((p) => `• ${p}`).join('\n')}\n\nSaved in the last 24h: ${report.savedLast24h} articles across ${report.runsLast24h} runs.`);
      if (!alerted) logger.warn('⚠ [health] no admin chat configured (TELEGRAM_ADMIN_CHAT_ID) or send failed');
    } else {
      logger.info(`🩺 [health] OK: ${report.savedLast24h} articles saved in ${report.runsLast24h} runs`);
    }
    return { ...report, alerted, services };
  }
}

export const healthCheckService = new HealthCheckService();
