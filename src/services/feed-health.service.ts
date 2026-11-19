import { jobStateService } from './job-state.service';
import type { FeedStatus } from './rss.service';

export const FEED_HEALTH_KEY = 'rss:feed_health';

export interface FeedHealth {
  outlet: string;
  /** Consecutive UTC days on which the feed failed (counted once per day). */
  failDays: number;
  lastFailDate: string | null;
  lastOkDate: string | null;
  lastError: string | null;
}

export type FeedHealthMap = Record<string, FeedHealth>;

/** Pure update: a failure counts once per day; any success resets the streak. */
export function updateFeedHealth(map: FeedHealthMap, status: FeedStatus[], now: Date): FeedHealthMap {
  const today = now.toISOString().slice(0, 10);
  const next: FeedHealthMap = { ...map };
  for (const feed of status) {
    const prev = next[feed.url] ?? { outlet: feed.outlet, failDays: 0, lastFailDate: null, lastOkDate: null, lastError: null };
    next[feed.url] = feed.ok
      ? { ...prev, outlet: feed.outlet, failDays: 0, lastOkDate: today }
      : {
          ...prev,
          outlet: feed.outlet,
          failDays: prev.lastFailDate === today ? prev.failDays : prev.failDays + 1,
          lastFailDate: today,
          lastError: feed.error ?? 'unknown error',
        };
  }
  return next;
}

class FeedHealthService {
  async get(): Promise<FeedHealthMap> {
    const raw = await jobStateService.get(FEED_HEALTH_KEY);
    try {
      return raw ? (JSON.parse(raw) as FeedHealthMap) : {};
    } catch {
      return {};
    }
  }

  async record(status: FeedStatus[], now: Date = new Date()): Promise<void> {
    await jobStateService.set(FEED_HEALTH_KEY, JSON.stringify(updateFeedHealth(await this.get(), status, now)));
  }
}

export const feedHealthService = new FeedHealthService();
