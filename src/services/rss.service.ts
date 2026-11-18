import { createHash } from 'crypto';
import Parser from 'rss-parser';
import { logger } from '../utils/logger';
import { Article } from '../types';

export interface RssFeed {
  outlet: string;
  url: string;
  category: string; // one of ALLOWED_CATEGORIES
}

/**
 * Free Indian outlet feeds. Only feeds whose items carry a description are
 * listed: the AI summary is generated from it (feeds with title-only items,
 * such as Times of India and Indian Express section feeds, gave poor summaries).
 * Checked 18-Nov-2026: all return 200 with images.
 */
export const RSS_FEEDS: RssFeed[] = [
  { outlet: 'The Hindu', url: 'https://www.thehindu.com/news/national/feeder/default.rss', category: 'nation' },
  { outlet: 'The Hindu', url: 'https://www.thehindu.com/business/feeder/default.rss', category: 'business' },
  { outlet: 'The Hindu', url: 'https://www.thehindu.com/sport/feeder/default.rss', category: 'sports' },
  { outlet: 'The Hindu', url: 'https://www.thehindu.com/sci-tech/technology/feeder/default.rss', category: 'technology' },
  { outlet: 'The Hindu', url: 'https://www.thehindu.com/entertainment/feeder/default.rss', category: 'entertainment' },
  { outlet: 'Hindustan Times', url: 'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml', category: 'nation' },
  { outlet: 'Hindustan Times', url: 'https://www.hindustantimes.com/feeds/rss/cricket/rssfeed.xml', category: 'sports' },
  { outlet: 'Hindustan Times', url: 'https://www.hindustantimes.com/feeds/rss/entertainment/rssfeed.xml', category: 'entertainment' },
  { outlet: 'Mint', url: 'https://www.livemint.com/rss/news', category: 'business' },
  { outlet: 'Mint', url: 'https://www.livemint.com/rss/markets', category: 'business' },
  { outlet: 'NDTV', url: 'https://feeds.feedburner.com/ndtvnews-top-stories', category: 'nation' },
];

/** Max new RSS articles enriched per run (each costs ~8 Groq calls). */
export const RSS_MAX_ARTICLES = Math.max(1, parseInt(process.env.RSS_MAX_ARTICLES || '15', 10) || 15);
const MAX_AGE_HOURS = 36;
const MIN_DESCRIPTION_CHARS = 40;

type FeedItem = Parser.Item & {
  mediaContent?: Array<{ $?: { url?: string; medium?: string; type?: string } }>;
  mediaThumbnail?: { $?: { url?: string } };
};

const parser: Parser<object, FeedItem> = new Parser({
  timeout: 15_000,
  headers: { 'User-Agent': 'DailyBytesBot/1.0 (+https://daily-bytes-ten.vercel.app)' },
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail'],
    ] as any,
  },
});

/** Canonical article URL: no fragment, no tracking parameters, so the URL dedupe works across feeds. */
export function normalizeArticleUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ref$|cmp$|publisher$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return raw.trim();
  }
}

function imageOf(item: FeedItem): string | null {
  const media = item.mediaContent?.find((m) => m.$?.url && (!m.$.medium || m.$.medium === 'image'))?.$?.url;
  const enclosure = item.enclosure?.type?.startsWith('image') ? item.enclosure.url : undefined;
  return media || item.mediaThumbnail?.$?.url || enclosure || null;
}

function plainText(text: string | undefined): string {
  return (text || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Feed item -> Article, or null if it is too old, undated or has no usable description. */
export function toArticle(item: FeedItem, feed: RssFeed, now: Date = new Date()): Article | null {
  if (!item.title || !item.link) return null;
  const published = item.isoDate ? new Date(item.isoDate) : item.pubDate ? new Date(item.pubDate) : null;
  if (!published || Number.isNaN(published.getTime())) return null;
  const ageHours = (now.getTime() - published.getTime()) / 3_600_000;
  if (ageHours > MAX_AGE_HOURS || ageHours < -1) return null;
  const description = plainText(item.contentSnippet || item.content || item.summary);
  if (description.length < MIN_DESCRIPTION_CHARS) return null;
  const url = normalizeArticleUrl(item.link);
  return {
    id: createHash('md5').update(url).digest('hex'),
    title: plainText(item.title),
    url,
    content: description,
    publishedAt: published,
    imageUrl: imageOf(item),
    category: feed.category,
  };
}

/**
 * Interleave per-feed lists (newest first within each feed) so one busy feed
 * can't fill the whole run: feed1[0], feed2[0], ..., feed1[1], feed2[1], ...
 */
export function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const list of lists) if (i < list.length) out.push(list[i]);
  }
  return out;
}

class RssService {
  /**
   * Candidate articles from every feed, interleaved and de-duplicated by URL.
   * Returns more than RSS_MAX_ARTICLES on purpose: the pipeline drops ones
   * already in the database and then keeps the first RSS_MAX_ARTICLES.
   */
  async fetchCandidates(feeds: RssFeed[] = RSS_FEEDS, now: Date = new Date()): Promise<Article[]> {
    const results = await Promise.allSettled(feeds.map((feed) => parser.parseURL(feed.url)));
    const perFeed: Article[][] = results.map((result, i) => {
      const feed = feeds[i];
      if (result.status === 'rejected') {
        logger.warn(`⚠ [rss] ${feed.outlet} ${feed.url} failed: ${result.reason?.message ?? result.reason}`);
        return [];
      }
      return result.value.items
        .map((item) => toArticle(item, feed, now))
        .filter((a): a is Article => a !== null)
        .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
    });
    const seen = new Set<string>();
    const candidates = interleave(perFeed).filter((a) => !seen.has(a.url) && (seen.add(a.url), true));
    const okFeeds = results.filter((r) => r.status === 'fulfilled').length;
    logger.info(`📡 [rss] ${candidates.length} candidate articles from ${okFeeds}/${feeds.length} feeds`);
    return candidates;
  }
}

export const rssService = new RssService();
