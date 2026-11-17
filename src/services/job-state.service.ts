import { rawClient } from '../db/client';

/**
 * Small key/value store in the database for scheduler bookkeeping
 * (e.g. when cleanup last ran), so it survives restarts and Render sleeps.
 */
class JobStateService {
  private ensured: Promise<void> | null = null;

  // The table is also created by `npm run db:migrate`; creating it lazily here
  // means a deploy that skipped the migration still works.
  private ensureTable(): Promise<void> {
    if (!this.ensured) {
      this.ensured = rawClient
        .execute(`
          CREATE TABLE IF NOT EXISTS job_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `)
        .then(() => undefined)
        .catch((err) => {
          this.ensured = null;
          throw err;
        });
    }
    return this.ensured;
  }

  async get(key: string): Promise<string | null> {
    await this.ensureTable();
    const result = await rawClient.execute({
      sql: 'SELECT value FROM job_state WHERE key = ?',
      args: [key],
    });
    const value = result.rows[0]?.value;
    return typeof value === 'string' ? value : null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.ensureTable();
    await rawClient.execute({
      sql: `INSERT INTO job_state (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      args: [key, value, new Date().toISOString()],
    });
  }
}

export const jobStateService = new JobStateService();
