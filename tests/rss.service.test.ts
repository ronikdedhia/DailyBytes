import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { rssService, toArticle, interleave, normalizeArticleUrl, RssFeed } from '../src/services/rss.service';

const NOW = new Date('2026-11-18T12:00:00Z');
const desc = 'A description long enough to summarise, with more than forty characters in it.';

const item = (title: string, link: string, hoursAgo: number, extra = '') => `
  <item>
    <title><![CDATA[${title}]]></title>
    <link>${link}</link>
    <description><![CDATA[<p>${desc}</p>]]></description>
    <pubDate>${new Date(NOW.getTime() - hoursAgo * 3_600_000).toUTCString()}</pubDate>
    ${extra}
  </item>`;
const rss = (items: string) => `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>t</title>${items}</channel></rss>`;

let server: http.Server;
let base = '';
const bodies: Record<string, string> = {
  '/sports.xml': rss(
    item('Pant fit for first Test', 'https://ex.com/a?utm_source=rss#publisher=x', 1, '<media:content url="https://img.ex.com/a.jpg" medium="image"/>') +
    item('Old story', 'https://ex.com/old', 72) +
    item('Second sports story', 'https://ex.com/b', 3, '<enclosure url="https://img.ex.com/b.jpg" type="image/jpeg" length="1"/>'),
  ),
  '/business.xml': rss(
    item('Sensex closes higher', 'https://ex.com/c', 2) +
    item('Pant fit for first Test (dup)', 'https://ex.com/a', 2),
  ),
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const body = bodies[req.url || ''];
    res.writeHead(body ? 200 : 500, { 'Content-Type': 'application/rss+xml' });
    res.end(body ?? 'boom');
  });
  server.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('rssService.fetchCandidates (real parser, local feeds)', () => {
  it('parses, filters old items, dedupes by URL, interleaves feeds and survives a broken feed', async () => {
    const feeds: RssFeed[] = [
      { outlet: 'S', url: `${base}/sports.xml`, category: 'sports' },
      { outlet: 'B', url: `${base}/business.xml`, category: 'business' },
      { outlet: 'X', url: `${base}/broken.xml`, category: 'nation' },
    ];
    const out = await rssService.fetchCandidates(feeds, NOW);
    expect(out.map((a) => a.url)).toEqual(['https://ex.com/a', 'https://ex.com/c', 'https://ex.com/b']);
    expect(out[0]).toMatchObject({ title: 'Pant fit for first Test', category: 'sports', imageUrl: 'https://img.ex.com/a.jpg', content: desc });
    expect(out[2].imageUrl).toBe('https://img.ex.com/b.jpg');
    expect(out[1].imageUrl).toBeNull();
  });
});

describe('rss helpers', () => {
  const feed: RssFeed = { outlet: 'S', url: 'x', category: 'sports' };
  it('drops items with a too-short description', () => {
    expect(toArticle({ title: 't', link: 'https://e.com/x', contentSnippet: 'short', isoDate: NOW.toISOString() }, feed, NOW)).toBeNull();
  });
  it('drops undated items', () => {
    expect(toArticle({ title: 't', link: 'https://e.com/x', contentSnippet: desc }, feed, NOW)).toBeNull();
  });
  it('strips fragments and tracking params', () => {
    expect(normalizeArticleUrl('https://e.com/a?id=1&utm_medium=x&fbclid=y#frag')).toBe('https://e.com/a?id=1');
  });
  it('interleaves lists', () => {
    expect(interleave([[1, 2, 3], [4], [5, 6]])).toEqual([1, 4, 5, 2, 6, 3]);
  });
});
