import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
vi.mock('../src/services/job-state.service', () => ({
  jobStateService: {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
  },
}));
vi.mock('../src/services/cleanup.service', () => ({
  cleanupService: { deleteOldArticles: vi.fn(async () => ({ deleted: 7 })) },
}));
vi.mock('../src/services/pipeline.service', () => ({ pipelineService: {} }));

import {
  decideCleanup, executeCleanupJob, CLEANUP_STATE_KEY, CLEANUP_MAX_AGE_DAYS,
} from '../src/cron/news-pipeline.cron';
import { cleanupService } from '../src/services/cleanup.service';

const day = 24 * 60 * 60 * 1000;
const t0 = new Date('2026-11-01T12:30:00Z');

describe('decideCleanup', () => {
  it('initialises when nothing is recorded', () => {
    expect(decideCleanup(null, t0)).toBe('initialize');
    expect(decideCleanup(new Date('garbage'), t0)).toBe('initialize');
  });
  it('skips before 15 days and runs at 15', () => {
    expect(decideCleanup(t0, new Date(t0.getTime() + 14 * day))).toBe('skip');
    expect(decideCleanup(t0, new Date(t0.getTime() + 15 * day))).toBe('run');
  });
});

describe('executeCleanupJob', () => {
  beforeEach(() => { store.clear(); vi.mocked(cleanupService.deleteOldArticles).mockClear(); });

  it('records the first check in the DB without deleting', async () => {
    await executeCleanupJob(t0);
    expect(store.get(CLEANUP_STATE_KEY)).toBe(t0.toISOString());
    expect(cleanupService.deleteOldArticles).not.toHaveBeenCalled();
  });

  it('uses the stored time, so a restart does not reset the interval', async () => {
    store.set(CLEANUP_STATE_KEY, t0.toISOString());
    // Simulates a fresh process 20 days later: no in-memory state, only the DB.
    const later = new Date(t0.getTime() + 20 * day);
    await executeCleanupJob(later);
    expect(cleanupService.deleteOldArticles).toHaveBeenCalledTimes(1);
    expect(cleanupService.deleteOldArticles).toHaveBeenCalledWith(CLEANUP_MAX_AGE_DAYS);
    expect(store.get(CLEANUP_STATE_KEY)).toBe(later.toISOString());
  });

  it('does not delete inside the interval', async () => {
    store.set(CLEANUP_STATE_KEY, t0.toISOString());
    await executeCleanupJob(new Date(t0.getTime() + 3 * day));
    expect(cleanupService.deleteOldArticles).not.toHaveBeenCalled();
  });

  it('runs once even if node-cron and QStash fire together', async () => {
    store.set(CLEANUP_STATE_KEY, t0.toISOString());
    const later = new Date(t0.getTime() + 20 * day);
    await Promise.all([executeCleanupJob(later), executeCleanupJob(later)]);
    expect(cleanupService.deleteOldArticles).toHaveBeenCalledTimes(1);
  });
});
