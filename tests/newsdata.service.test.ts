import { describe, it, expect, vi } from 'vitest';
import { newsDataService } from '../src/services/newsdata.service';

describe('newsDataService.fetchLatestNews', () => {
  it('does not send from_date (archive-only) to the latest-news endpoint', async () => {
    const get = vi.fn(async () => ({
      data: {
        status: 'success',
        totalResults: 1,
        results: [{
          article_id: 'a1', title: 'Title', link: 'https://example.com/a1',
          description: 'Desc', pubDate: '2026-11-17 10:00:00',
          image_url: 'https://example.com/a1.jpg', category: ['technology'],
        }],
      },
    }));
    (newsDataService as any).client.get = get;

    const articles = await newsDataService.fetchLatestNews(10);

    const [, options] = get.mock.calls[0] as unknown as [string, { params: Record<string, unknown> }];
    expect(options.params).not.toHaveProperty('from_date');
    expect(options.params).toMatchObject({ country: 'in', language: 'en', size: 10 });
    expect(articles).toHaveLength(1);
    expect(articles[0].url).toBe('https://example.com/a1');
  });
});
